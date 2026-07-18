// JORYSI 外部爬虫 —— 在 GitHub Actions 里用真实浏览器抓取，绕过 Cloudflare 验证页。
// 抓到产品目录 + 信息页文字后，POST 到 Worker 的 /ingest 端点写入 KV。
//
// 需要的环境变量（在 GitHub 仓库 Settings → Secrets 里配）：
//   WORKER_URL    例如 https://jorysigpt.kentooi96.workers.dev
//   INGEST_TOKEN  跟 Worker 里那个 Secret 一模一样的密钥
//
// 本地测试： WORKER_URL=... INGEST_TOKEN=... node crawl.js

// 用 playwright-extra + stealth 插件（修补几十个自动化指纹），大幅提高过 Cloudflare 验证页的概率
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const SITE = process.env.SITE || "https://www.jorysi.my";
const LIST_PATH = process.env.LIST_PATH || "/products/all-products";
const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "");
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "80", 10);
const BUDGET_MS = parseInt(process.env.BUDGET_MS || String(10.5 * 60 * 1000), 10); // 抓取总预算，到点就收工推送
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const INFO_PAGES = [
  "/faq",
  "/pages/hair--scalp-knowledge",
  "/return-and-refund-policy",
  "/pages/delivery-methods-info",
  "/about-us",
  "/pages/membership-faq",
  "/terms-and-conditions",
  "/contact-us",
];

const START = Date.now();
const elapsed = () => Math.round((Date.now() - START) / 1000);
const timeLeft = () => BUDGET_MS - (Date.now() - START);

// ---------- 产品列表解析（跟 Worker 里的 parseListing 完全一致）----------
function num(x) { const f = parseFloat(x); return isNaN(f) ? null : f; }
function shortVariantName(vname, pname) {
  if (!vname) return "";
  return vname.startsWith(pname) ? vname.slice(pname.length).replace(/^[\s-]+/, "") : vname;
}
function parseListing(html) {
  let i = html.indexOf("productListingPagination");
  if (i < 0) return null;
  let chunk = html.slice(i, i + 600000);
  chunk = chunk.replace(/\\\\\\"/g, "@Q@").replace(/\\"/g, '"').replace(/@Q@/g, '\\"');
  const lastPage = +(chunk.match(/"last_page":(\d+)/) || [])[1] || null;
  const di = chunk.indexOf('"data":[');
  if (di < 0) return null;
  const start = di + 7;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let j = start; j < chunk.length; j++) {
    const c = chunk[j];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) return null;
  let arr;
  try { arr = JSON.parse(chunk.slice(start, end)); } catch (e) { return null; }

  const items = [];
  for (const p of arr) {
    if (!p || !p.name) continue;
    const variants = (p.variants || []).map(v => ({
      n: shortVariantName(v.name, p.name),
      p: num(v.special_price && v.special_price.price) ?? num(v.price),
      q: v.quantity ?? null,
    }));
    let price = num(p.special_price && p.special_price.price) ?? num(p.price);
    let qty = p.quantity ?? num(p.stock_quantity);
    if (variants.length) {
      const ps = variants.map(v => v.p).filter(x => x != null);
      if (ps.length) price = { min: Math.min(...ps), max: Math.max(...ps) };
      qty = variants.reduce((s, v) => s + (v.q || 0), 0);
    }
    const img = (p.images && p.images[0] && (p.images[0].x420_url || p.images[0].url)) || "";
    items.push({
      sku: p.sku || "", n: p.name, b: (p.brands && p.brands.name) || "",
      pr: price, q: qty, st: p.product_status || "",
      u: p.seo && p.seo.url_handle ? "/product/" + p.seo.url_handle : "",
      img, v: variants.slice(0, 15),
    });
  }
  return { items, lastPage };
}

function isChallengeText(t) {
  return /just a moment|enable javascript|verify you are human|checking your browser|attention required|needs to review the security/i.test(t || "");
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 读当前页面状态（跨越 Cloudflare 跳转时 evaluate 可能短暂失败，容错处理）
async function readState(page) {
  try {
    return await page.evaluate(() => ({
      title: document.title || "",
      len: document.body ? document.body.innerText.length : 0,
      snippet: document.body ? document.body.innerText.replace(/\s+/g, " ").slice(0, 220) : "",
      htmlLen: document.documentElement ? document.documentElement.innerHTML.length : 0,
    }));
  } catch (e) { return { title: "", len: 0, snippet: "(页面跳转中)", htmlLen: 0 }; }
}

// 打开一个页面并等它通过验证、加载出真实内容。用轮询而非 waitForFunction，
// 这样 Cloudflare 通过后重载页面时不会因执行上下文销毁而误判失败。返回 { ok, challenged }。
async function gotoPage(page, url, label) {
  try {
    await page.goto(url, { waitUntil: "commit", timeout: 45000 });
  } catch (e) {
    console.log(`  [${label}] 打开失败: ${String(e).slice(0, 120)}`);
    return { ok: false, challenged: false };
  }
  const deadline = Date.now() + 45000;
  let last = { title: "", len: 0, snippet: "", htmlLen: 0 };
  while (Date.now() < deadline) {
    await sleep(2500);
    last = await readState(page);
    const challenged = isChallengeText(last.snippet) || isChallengeText(last.title);
    if (last.len > 250 && !challenged) {
      await sleep(600);
      return { ok: true, challenged: false };
    }
  }
  const challenged = isChallengeText(last.snippet) || isChallengeText(last.title);
  console.log(`  [${label}] 未就绪 → 标题="${last.title}" | 正文${last.len}字 | html${last.htmlLen}字节 | 片段="${last.snippet}"`);
  return { ok: false, challenged };
}

// ---------- 主流程 ----------
async function main() {
  if (!WORKER_URL || !INGEST_TOKEN) {
    console.error("缺少 WORKER_URL 或 INGEST_TOKEN 环境变量");
    process.exit(1);
  }

  // 默认「有头」模式（配合 workflow 里的 xvfb 虚拟屏幕），比无头更难被识别。
  // 想强制无头可设环境变量 HEADLESS=1。
  const headless = process.env.HEADLESS === "1";
  const browser = await chromium.launch({
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1366,850",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 850 },
    locale: "en-US",
    timezoneId: "Asia/Kuala_Lumpur",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9,ms;q=0.8,zh;q=0.7" },
  });
  console.log(`浏览器已启动（${headless ? "无头" : "有头+xvfb"}，stealth 已启用）`);
  const page = await context.newPage();

  // ---- 产品 ----
  let catalog = {};
  let challengeBlocked = false;
  try {
    let pageNum = 1, lastPage = 1, consecFail = 0;
    do {
      if (timeLeft() < 60000) { console.log(`  ⏳ 接近时间预算，产品抓到第 ${pageNum - 1} 页先停`); break; }
      const url = `${SITE}${LIST_PATH}?page=${pageNum}`;
      const r = await gotoPage(page, url, "product p" + pageNum);
      if (!r.ok) {
        consecFail++;
        if (r.challenged) challengeBlocked = true;
        // 第一页就过不了、或连续两页失败 → 立刻收手，别耗光时间
        if (pageNum === 1 || consecFail >= 2) {
          console.log(`  ✋ 产品抓取提前停止（${r.challenged ? "过不了验证页" : "页面异常"}），已在第 ${pageNum} 页`);
          break;
        }
        pageNum++;
        continue;
      }
      consecFail = 0;
      const parsed = parseListing(await page.content());
      if (!parsed) { console.log(`  产品第 ${pageNum} 页解析不到数据`); break; }
      if (parsed.lastPage) lastPage = parsed.lastPage;
      for (const item of parsed.items) catalog[item.sku || item.n] = { ...item, seen: 1 };
      console.log(`  产品第 ${pageNum}/${lastPage} 页：+${parsed.items.length}（累计 ${Object.keys(catalog).length}，用时 ${elapsed()}s）`);
      pageNum++;
      await page.waitForTimeout(300);
    } while (pageNum <= lastPage && pageNum <= MAX_PAGES);
  } catch (e) {
    console.log("  产品抓取中断：" + String(e).slice(0, 150));
  }

  // ---- 信息页 ----
  const docs = {};
  for (const path of INFO_PAGES) {
    if (timeLeft() < 30000) { console.log("  ⏳ 时间预算用尽，信息页抓到此为止"); break; }
    const r = await gotoPage(page, SITE + path, "info " + path);
    if (!r.ok) {
      if (r.challenged) challengeBlocked = true;
      console.log(`  信息页 ${path} 失败（${r.challenged ? "验证页" : "异常"}）`);
      continue;
    }
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
    docs[path] = text.slice(0, 8000);
    console.log(`  信息页 ${path}：${docs[path].length} 字`);
  }

  await browser.close();

  // ---- 推送到 Worker ----
  const productCount = Object.keys(catalog).length;
  if (productCount >= 50) {
    await postIngest({ catalog }, "产品目录 (" + productCount + ")");
  } else {
    console.log(`⚠️ 只抓到 ${productCount} 个产品，太少，不推送（避免清空线上目录）`);
  }
  if (Object.keys(docs).length) {
    await postIngest({ docs }, "信息页 (" + Object.keys(docs).length + ")");
  }

  console.log(`\n===== 小结（总用时 ${elapsed()}s）=====`);
  console.log(`产品: ${productCount} | 信息页: ${Object.keys(docs).length}/${INFO_PAGES.length}`);
  if (challengeBlocked && productCount < 50) {
    console.log("❌ 关键问题：浏览器没能通过 Cloudflare 验证页。把这行连同上面的日志发给开发，需要加强 stealth 或换渲染方式。");
    process.exit(1);
  }
  console.log("✅ 完成");
  process.exit(0);
}

async function postIngest(payload, label) {
  try {
    const res = await fetch(WORKER_URL + "/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": INGEST_TOKEN },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    console.log(`→ 推送${label}：HTTP ${res.status} ${txt.slice(0, 300)}`);
  } catch (e) {
    console.log(`→ 推送${label} 出错：${String(e).slice(0, 200)}`);
  }
}

main().catch(e => { console.error("崩溃:", e); process.exit(1); });
