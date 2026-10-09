// Background script: looks up a product on toppreise.ch and returns the lowest price.
// Runs as a Firefox event page, so fetch() and DOMParser are both available.

const TOPPREISE = "https://www.toppreise.ch";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours: be polite, don't hammer Toppreise
const CACHE_VERSION = "v2"; // bump this to throw away old (possibly wrong) cached results
const MIN_SIMILARITY = 0.5; // how alike the two product names must be (0..1)

// ---- Things you may need to tweak after looking at Toppreise's real HTML ----
const SEARCH_URL = (q) => `${TOPPREISE}/produktsuche?q=${encodeURIComponent(q)}`;
// Links that point to a single product's comparison page.
const PRODUCT_LINK_SELECTOR = 'a[href*="/preisvergleich/"]';
// ------------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "lookup") return lookup(msg.product);
});

async function lookup(product) {
  const hasAccess = await browser.permissions.contains({ origins: [`${TOPPREISE}/*`] });
  if (!hasAccess) return { status: "no-permission" };
  if (!product.name) return { status: "not-found" };

  const cacheKey = `tp:${CACHE_VERSION}:${product.gtin || product.mpn || product.name}`;
  const cached = (await browser.storage.local.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.result;

  // Try the most exact identifier first, then fall back to looser ones.
  const attempts = [
    product.gtin && { query: product.gtin, matchedBy: "EAN" },
    product.mpn && { query: product.mpn, matchedBy: "part number" },
    { query: product.name, matchedBy: "name" },
  ].filter(Boolean);

  let result = { status: "not-found", searchUrl: SEARCH_URL(product.name) };
  try {
    for (const { query, matchedBy } of attempts) {
      const found = await searchToppreise(query, product.name);
      console.log("[Toppreise Check]", matchedBy, query, "→", found);
      if (found) {
        result = { status: "ok", ...found, matchedBy };
        break;
      }
    }
  } catch (err) {
    return { status: "error", message: String(err.message || err), searchUrl: SEARCH_URL(product.name) };
  }

  await browser.storage.local.set({ [cacheKey]: { time: Date.now(), result } });
  return result;
}

// Returns an offer for the product, or null if nothing on Toppreise really matches it.
async function searchToppreise(query, wantedName) {
  const search = await fetchPage(SEARCH_URL(query));

  // Case 1: Toppreise jumped straight to a product page (common for an exact EAN).
  if (search.url.includes("/preisvergleich/")) {
    return checkedOffer(search.doc, search.url, wantedName);
  }

  // Case 2: a results list. Score every product link by how well it matches our product
  // and only open the best one, instead of blindly taking the first link on the page.
  const candidates = [...search.doc.querySelectorAll(PRODUCT_LINK_SELECTOR)]
    .map((a) => {
      const url = new URL(a.getAttribute("href"), TOPPREISE).href;
      const label = `${a.textContent} ${a.title || ""} ${slugText(url)}`;
      return { url, score: similarity(wantedName, label) };
    })
    .filter((c) => c.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  const page = await fetchPage(candidates[0].url);
  return checkedOffer(page.doc, page.url, wantedName);
}

// Read the offer from a product page, but only accept it if the names match.
function checkedOffer(doc, url, wantedName) {
  const offer = extractOffer(doc);
  if (!offer) return null;
  const name = offer.name || pageTitle(doc);
  const score = similarity(wantedName, name || slugText(url));
  if (score < MIN_SIMILARITY) {
    console.log("[Toppreise Check] rejected:", name, "score", score.toFixed(2));
    return null;
  }
  return { ...offer, name, url };
}

async function fetchPage(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Toppreise answered HTTP ${res.status}`);
  const html = await res.text();
  return { url: res.url, doc: new DOMParser().parseFromString(html, "text/html") };
}

// ---------- Name matching ----------

// Words that say nothing about which product it is.
const NOISE = new Set(["the", "and", "mit", "und", "for", "für", "with", "wireless", "black", "white", "schwarz", "weiss"]);

function tokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9äöü]+/)
      .filter((t) => t.length >= 1 && !NOISE.has(t))
  );
}

// 0 = nothing in common, 1 = all words of the shorter name appear in the other one.
// Also: if both names contain numbers but share none (e.g. "Pro 2" vs "Pro 3"),
// they are treated as different products.
function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;

  const shared = [...A].filter((t) => B.has(t));
  const numsA = [...A].filter((t) => /\d/.test(t));
  const numsB = [...B].filter((t) => /\d/.test(t));
  if (numsA.length && numsB.length && !shared.some((t) => /\d/.test(t))) return 0;

  const words = shared.filter((t) => t.length >= 2).length + shared.filter((t) => t.length < 2).length * 0.5;
  return words / Math.min(A.size, B.size);
}

// "/preisvergleich/Kopfhoerer/APPLE-AirPods-Pro-3-p123" -> "APPLE AirPods Pro 3"
function slugText(url) {
  const last = new URL(url).pathname.split("/").pop() || "";
  return last.replace(/-p\d+$/, "").replace(/-/g, " ");
}

function pageTitle(doc) {
  const og = doc.querySelector('meta[property="og:title"]');
  if (og && og.content) return og.content;
  const h1 = doc.querySelector("h1");
  return h1 ? h1.textContent.trim() : null;
}

// ---------- Price extraction ----------

// Pull the lowest price out of a page. Tries structured data (JSON-LD) first,
// then falls back to scanning the visible text for "CHF 123.45".
function extractOffer(doc) {
  for (const data of readJsonLd(doc)) {
    const offers = data.offers;
    if (!offers) continue;

    if (offers["@type"] === "AggregateOffer" && offers.lowPrice != null) {
      return {
        lowPrice: parsePrice(offers.lowPrice),
        offerCount: offers.offerCount ? Number(offers.offerCount) : null,
        shop: null,
        name: data.name || null,
        approximate: false,
      };
    }

    const list = Array.isArray(offers) ? offers : [offers];
    const priced = list
      .map((o) => ({ price: parsePrice(o.price), shop: o.seller && o.seller.name }))
      .filter((o) => o.price != null);
    if (priced.length) {
      priced.sort((a, b) => a.price - b.price);
      return {
        lowPrice: priced[0].price,
        offerCount: priced.length,
        shop: priced[0].shop || null,
        name: data.name || null,
        approximate: false,
      };
    }
  }

  // Fallback: only trust it on a page that looks like a single product comparison.
  if (!doc.querySelector('meta[property="og:type"][content="product"]')) return null;
  const text = doc.body ? doc.body.textContent : "";
  const prices = [...text.matchAll(/CHF\s*([\d'’]+(?:\.(?:\d{2}|–|-))?)/g)]
    .map((m) => parsePrice(m[1]))
    .filter((p) => p != null && p >= 1); // skip "CHF 0.00" shipping lines etc.
  if (!prices.length) return null;
  return { lowPrice: Math.min(...prices), offerCount: null, shop: null, name: null, approximate: true };
}

function readJsonLd(doc) {
  const out = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      collect(JSON.parse(script.textContent), out);
    } catch {
      /* ignore broken JSON-LD */
    }
  }
  return out;
}

function collect(node, out) {
  if (Array.isArray(node)) return node.forEach((n) => collect(n, out));
  if (!node || typeof node !== "object") return;
  if (node["@graph"]) collect(node["@graph"], out);
  if (node["@type"] === "Product" || (Array.isArray(node["@type"]) && node["@type"].includes("Product"))) {
    out.push(node);
  }
}

function parsePrice(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/['’\s]/g, "").replace(/\.(–|-)$/, ".00").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
