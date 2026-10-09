// Background script: looks up a product on toppreise.ch and returns the lowest price.
// Runs as a Firefox event page, so fetch() and DOMParser are both available.

const TOPPREISE = "https://www.toppreise.ch";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours: be polite, don't hammer Toppreise

// ---- Things you will probably need to tweak after looking at Toppreise's real HTML ----
const SEARCH_URL = (q) => `${TOPPREISE}/produktsuche?q=${encodeURIComponent(q)}`;
// Links on the search results page that point to a single product's comparison page.
const PRODUCT_LINK_SELECTOR = 'a[href*="/preisvergleich/"]';
// ----------------------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "lookup") return lookup(msg.product);
});

async function lookup(product) {
  const hasAccess = await browser.permissions.contains({ origins: [`${TOPPREISE}/*`] });
  if (!hasAccess) return { status: "no-permission" };

  // Prefer an exact identifier; fall back to the product name.
  const query = product.gtin || product.mpn || product.name;
  const matchedBy = product.gtin ? "EAN" : product.mpn ? "part number" : "name";
  if (!query) return { status: "not-found" };

  const cacheKey = `tp:${query}`;
  const cached = (await browser.storage.local.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.result;

  let result;
  try {
    result = await searchToppreise(query, matchedBy);
  } catch (err) {
    return { status: "error", message: String(err.message || err), searchUrl: SEARCH_URL(query) };
  }

  await browser.storage.local.set({ [cacheKey]: { time: Date.now(), result } });
  return result;
}

async function searchToppreise(query, matchedBy) {
  const searchUrl = SEARCH_URL(query);
  const search = await fetchPage(searchUrl);

  // Case 1: Toppreise jumped straight to the product page (common for an exact EAN),
  // or the search page itself carries offer data.
  let offer = extractOffer(search.doc);
  let pageUrl = search.url;

  // Case 2: a normal results list -> open the first product and read its offers.
  if (!offer) {
    const link = search.doc.querySelector(PRODUCT_LINK_SELECTOR);
    if (!link) return { status: "not-found", searchUrl };
    pageUrl = new URL(link.getAttribute("href"), TOPPREISE).href;
    const product = await fetchPage(pageUrl);
    offer = extractOffer(product.doc);
  }

  if (!offer) return { status: "not-found", searchUrl };
  return { status: "ok", ...offer, url: pageUrl, matchedBy };
}

async function fetchPage(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Toppreise answered HTTP ${res.status}`);
  const html = await res.text();
  return { url: res.url, doc: new DOMParser().parseFromString(html, "text/html") };
}

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
