// Content script: runs on Swiss shops, reads the product on the page and shows a badge
// comparing the shop's price with the lowest price on Toppreise.

(() => {
  const BOX_ID = "tp-check-box";

  // One entry per supported shop.
  //  - name:   shown in the badge
  //  - idFromUrl (optional): pulls the shop's product number out of the URL. Used on
  //    single-page apps to make sure we don't read data left over from the previous product.
  const SITES = {
    "www.digitec.ch":      { name: "Digitec",      idFromUrl: /-(\d+)(?:[/?#]|$)/ },
    "www.galaxus.ch":      { name: "Galaxus",      idFromUrl: /-(\d+)(?:[/?#]|$)/ },
    "www.interdiscount.ch":{ name: "Interdiscount" },
    "www.brack.ch":        { name: "Brack" },
    "www.conrad.ch":       { name: "Conrad" },
  };
  const SITE = SITES[location.hostname];
  if (!SITE) return;

  let lastUrl = null;

  // Several of these shops are single-page apps: the URL changes without a page reload,
  // so we poll for URL changes and re-run when the user opens another product.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onPageChange();
    }
  }, 1000);

  async function onPageChange() {
    removeBox();

    // We don't rely on URL patterns to spot product pages (every shop differs);
    // a page counts as a product page if it describes exactly one product with a price.
    const product = await waitForProduct();
    if (!product) return;
    console.log("[SwissPriceComp]", SITE.name, product);

    render({ status: "loading" }, product);
    let result;
    try {
      result = await browser.runtime.sendMessage({ type: "lookup", product });
    } catch (err) {
      result = { status: "error", message: String(err.message || err) };
    }
    // The user may have navigated away while we were waiting.
    if (location.href === lastUrl) render(result, product);
  }

  // The product data can appear a moment after the page loads, so retry for a few seconds.
  async function waitForProduct() {
    for (let i = 0; i < 10; i++) {
      const p = extractProduct();
      if (p) return p;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  // Try the different ways shops describe products, most reliable first.
  function extractProduct() {
    const p = fromJsonLd() || fromMicrodata();
    if (!p || !p.name) return null;
    if (p.price == null) p.price = readMetaPrice();
    if (p.price == null || !(p.price > 0)) return null; // no price -> not a product page
    if (!p.brand) p.brand = readMeta("product:brand");
    return p;
  }

  // 1) JSON-LD: <script type="application/ld+json"> with "@type": "Product".
  function fromJsonLd() {
    const productId = SITE.idFromUrl ? (location.pathname.match(SITE.idFromUrl) || [])[1] : null;
    const products = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        collectProducts(JSON.parse(script.textContent), products);
      } catch {
        /* ignore broken JSON-LD */
      }
    }
    // Make sure this isn't stale data left over from the previous product.
    const fresh = productId ? products.filter((n) => JSON.stringify(n).includes(productId)) : products;
    // Category pages often list many products; only a single product means "product page".
    if (fresh.length !== 1) return null;

    const node = fresh[0];
    let offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    let price = null;
    if (offer) price = parsePrice(offer.price != null ? offer.price : offer.lowPrice);
    return {
      name: str(node.name),
      brand: brandName(node.brand || node.manufacturer),
      gtin: str(node.gtin13 || node.gtin || node.gtin14 || node.gtin12 || node.gtin8),
      mpn: str(node.mpn),
      price,
    };
  }

  function collectProducts(node, out) {
    if (Array.isArray(node)) return node.forEach((n) => collectProducts(n, out));
    if (!node || typeof node !== "object") return;
    if (node["@graph"]) collectProducts(node["@graph"], out);
    const type = node["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) out.push(node);
  }

  // 2) Microdata: itemtype="https://schema.org/Product" with itemprop attributes.
  function fromMicrodata() {
    const roots = document.querySelectorAll('[itemtype$="schema.org/Product"]');
    if (roots.length !== 1) return null;
    const root = roots[0];
    const prop = (name) => {
      const el = root.querySelector(`[itemprop="${name}"]`);
      if (!el) return null;
      const v = el.getAttribute("content") || el.getAttribute("value") || el.textContent;
      return v ? v.trim() : null;
    };
    const brandEl = root.querySelector('[itemprop="brand"]');
    let brand = null;
    if (brandEl) {
      const inner = brandEl.querySelector('[itemprop="name"]');
      brand = (inner || brandEl).getAttribute("content") || (inner || brandEl).textContent;
    }
    return {
      name: prop("name"),
      brand: str(brand),
      gtin: prop("gtin13") || prop("gtin") || prop("gtin14") || prop("gtin12") || prop("gtin8"),
      mpn: prop("mpn"),
      price: parsePrice(prop("price")),
    };
  }

  // JSON-LD "brand" can be a string, an object {name}, or a list of those.
  function brandName(b) {
    if (Array.isArray(b)) b = b[0];
    if (b && typeof b === "object") b = b.name;
    return str(b);
  }

  function readMeta(property) {
    const meta = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
    return meta && meta.content ? meta.content.trim() : null;
  }

  function readMetaPrice() {
    return parsePrice(readMeta("product:price:amount") || readMeta("og:price:amount"));
  }

  function str(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
  }

  // Handles 199, "199.00", "1'299.–", "CHF 1’299.90", "199,95".
  function parsePrice(value) {
    if (value == null) return null;
    if (typeof value === "number") return value;
    const cleaned = String(value)
      .replace(/CHF/i, "")
      .replace(/['’\s]/g, "")
      .replace(/\.(–|-)$/, ".00")
      .replace(",", ".");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- UI ----------

  function render(result, product) {
    removeBox();
    const box = el("div", { id: BOX_ID });
    const close = el("button", { className: "tp-close", title: "Close", textContent: "×" });
    close.addEventListener("click", removeBox);
    box.append(close, el("div", { className: "tp-title", textContent: "Toppreise" }));

    const body = el("div", { className: "tp-body" });
    box.append(body);

    switch (result && result.status) {
      case "loading":
        body.textContent = "Checking prices…";
        break;

      case "ok": {
        const here = product.price;
        const low = result.lowPrice;
        const line = el("div", { className: "tp-main" });

        if (here != null && low < here - 0.5) {
          box.classList.add("tp-cheaper");
          line.textContent = `CHF ${fmt(here - low)} cheaper than ${SITE.name}`;
        } else if (here != null) {
          box.classList.add("tp-best");
          line.textContent = `${SITE.name} has the best price`;
        } else {
          line.textContent = "Lowest price found";
        }
        body.append(line);

        if (here != null) body.append(el("div", { textContent: `${SITE.name}: CHF ${fmt(here)}` }));
        const detail = `Toppreise lowest: CHF ${fmt(low)}${result.approximate ? " (approx.)" : ""}` +
          (result.shop ? ` at ${result.shop}` : "") +
          (result.offerCount ? ` · ${result.offerCount} offers` : "");
        body.append(el("div", { textContent: detail }));
        if (result.name) {
          body.append(el("div", { className: "tp-matched", textContent: `Compared with: ${result.name}` }));
        }
        if (result.brandChecked === false && product.brand) {
          body.append(el("div", { className: "tp-note", textContent: `Couldn't confirm the brand (${product.brand}) on Toppreise.` }));
        }

        if (result.matchedBy !== "EAN") {
          body.append(el("div", { className: "tp-note", textContent: `Matched by ${result.matchedBy} — double-check it's the same item.` }));
        }
        body.append(link(result.url, "Open on Toppreise →"));
        break;
      }

      case "not-found":
        body.textContent = result.brandMismatch
          ? `Toppreise only found other brands (${result.brandMismatch}), not ${product.brand}.`
          : "No match found on Toppreise.";
        if (result.searchUrl) body.append(link(result.searchUrl, "Search manually →"));
        break;

      case "no-permission":
        body.textContent =
          "Allow access to toppreise.ch: about:addons → SwissPriceComp → Permissions, then reload.";
        break;

      default:
        body.textContent = `Couldn't check: ${(result && result.message) || "unknown error"}`;
        if (result && result.searchUrl) body.append(link(result.searchUrl, "Search manually →"));
    }

    document.body.append(box);
  }

  function removeBox() {
    const old = document.getElementById(BOX_ID);
    if (old) old.remove();
  }

  // Build elements with textContent only, never innerHTML (data comes from other sites).
  function el(tag, props) {
    return Object.assign(document.createElement(tag), props);
  }

  function link(href, text) {
    const a = el("a", { href, textContent: text, target: "_blank", rel: "noopener noreferrer" });
    a.className = "tp-link";
    return a;
  }

  function fmt(n) {
    return n.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
})();
