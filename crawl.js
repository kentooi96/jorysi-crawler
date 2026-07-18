// JORYSI 外部爬虫 —— 在 GitHub Actions 里用真实浏览器抓取，绕过 Cloudflare 验证页。
// 抓到产品目录 + 信息页文字后，POST 到 Worker 的 /ingest 端点写入 KV。
//
// 需要的环境变量（在 GitHub 仓库 Settings → Secrets 里配）：
//   WORKER_URL    例如 https://jorysigpt.kentooi96.workers.dev
//   INGEST_TOKEN  跟 Worker 里那个 Secret 一模一样的密钥
//
// 本地测试： WORKER_URL=... INGEST_TOKEN=... node crawl.js

const { chromium } = require("playwright");

const SITE = process.env.SITE || "https://www.jorysi.my";
const LIST_PATH = process.env.LIST_PATH || "/products/all-products";
const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "");
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "80", 10);
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

// ---------- 等待通过 Cloudflare 验证页 ----------
async function waitPastChallenge(page, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForFunction(() => {
        const t = document.body ? document.body.innerText : "";
        return t.length > 600 && !/just a moment|enable javascript|verify you are human|checking your browser|attention required/i.test(t);
      }, { timeout: 25000 });
      return true;
    } catch (e) {
      console.log(`  [${label}] 仍在验证页，第 ${attempt + 1} 次重试…`);
      await page.waitForTimeout(4000);
      try { await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }); } catch (_) {}
    }
  }
  return false;
}

async function gotoPage(page, url, label) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const ok = await waitPastChallenge(page, label);
  if (!ok) throw new Error("无法通过验证页: " + url);
  await page.waitForTimeout(800);
}

// ---------- 主流程 ----------
async function main() {
  if (!WORKER_URL || !INGEST_TOKEN) {
    console.error("缺少 WORKER_URL 或 INGEST_TOKEN 环境变量");
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 850 },
    locale: "en-US",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9,ms;q=0.8,zh;q=0.7" },
  });
  // 抹掉最明显的自动化指纹
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  let catalog = {};
  let productError = null;
  try {
    let pageNum = 1, lastPage = 1;
    do {
      const url = `${SITE}${LIST_PATH}?page=${pageNum}`;
      await gotoPage(page, url, "product p" + pageNum);
      const html = await page.content();
      const parsed = parseListing(html);
      if (!parsed) { console.log(`  产品第 ${pageNum} 页解析不到数据`); break; }
      if (parsed.lastPage) lastPage = parsed.lastPage;
      for (const item of parsed.items) catalog[item.sku || item.n] = { ...item, seen: 1 };
      console.log(`  产品第 ${pageNum}/${lastPage} 页：+${parsed.items.length}（累计 ${Object.keys(catalog).length}）`);
      pageNum++;
      await page.waitForTimeout(400);
    } while (pageNum <= lastPage && pageNum <= MAX_PAGES);
  } catch (e) {
    productError = String(e);
    console.log("  产品抓取中断：" + productError);
  }

  const docs = {};
  for (const path of INFO_PAGES) {
    try {
      await gotoPage(page, SITE + path, "info " + path);
      const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
      docs[path] = text.slice(0, 8000);
      console.log(`  信息页 ${path}：${docs[path].length} 字`);
    } catch (e) {
      console.log(`  信息页 ${path} 失败：${String(e)}`);
    }
  }

  await browser.close();

  // ---------- 推送到 Worker ----------
  const productCount = Object.keys(catalog).length;
  if (productCount >= 50) {
    await postIngest({ catalog }, "产品目录 (" + productCount + ")");
  } else {
    console.log(`⚠️ 只抓到 ${productCount} 个产品，太少，不推送（避免清空线上目录）`);
  }
  if (Object.keys(docs).length) {
    await postIngest({ docs }, "信息页 (" + Object.keys(docs).length + ")");
  }

  const hardFail = productCount < 50 && Object.keys(docs).length === 0;
  console.log(hardFail ? "❌ 本次抓取基本失败" : "✅ 完成");
  process.exit(hardFail ? 1 : 0);
}

async function postIngest(payload, label) {
  const res = await fetch(WORKER_URL + "/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-token": INGEST_TOKEN },
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  console.log(`→ 推送${label}：HTTP ${res.status} ${txt.slice(0, 300)}`);
  if (!res.ok) throw new Error("ingest 失败 " + res.status);
}

main().catch(e => { console.error("崩溃:", e); process.exit(1); });
