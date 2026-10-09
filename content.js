// Content script: runs on digitec.ch / galaxus.ch, reads the product and shows a badge.

(() => {
  const BOX_ID = "tp-check-box";
  let lastUrl = null;

  // Digitec/Galaxus is a single-page app: the URL changes without a page reload,
  // so we poll for URL changes and re-run when the user opens another product.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onPageChange();
    }
  }, 1000);

  async function onPageChange() {
    removeBox();
    if (!/\/product\//.test(location.pathname)) return;

    const product = await waitForProduct();
    if (!product) return;

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

  // The product data appears a moment after navigation, so retry for a few seconds.
  async function waitForProduct() {
    for (let i = 0; i < 10; i++) {
      const p = extractProduct();
      if (p) return p;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  // Reads the product from the page's structured data (JSON-LD).
  function extractProduct() {
    const productId = (location.pathname.match(/-(\d+)(?:[/?#]|$)/) || [])[1];

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      const nodes = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const node of nodes) {
        if (!node || node["@type"] !== "Product") continue;
        // Make sure this isn't stale data left over from the previous product.
        if (productId && !JSON.stringify(node).includes(productId)) continue;

        const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        return {
          name: node.name || null,
          gtin: node.gtin13 || node.gtin || node.gtin14 || node.gtin12 || node.gtin8 || null,
          mpn: node.mpn || null,
          price: offer && offer.price != null ? parseFloat(offer.price) : readMetaPrice(),
        };
      }
    }
    return null;
  }

  function readMetaPrice() {
    const meta = document.querySelector('meta[property="product:price:amount"]');
    return meta ? parseFloat(meta.content) : null;
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
          line.textContent = `CHF ${fmt(here - low)} cheaper elsewhere`;
        } else if (here != null) {
          box.classList.add("tp-best");
          line.textContent = "This is the best price";
        } else {
          line.textContent = "Lowest price found";
        }
        body.append(line);

        const detail = `Lowest: CHF ${fmt(low)}${result.approximate ? " (approx.)" : ""}` +
          (result.shop ? ` at ${result.shop}` : "") +
          (result.offerCount ? ` · ${result.offerCount} offers` : "");
        body.append(el("div", { textContent: detail }));

        if (result.matchedBy !== "EAN") {
          body.append(el("div", { className: "tp-note", textContent: `Matched by ${result.matchedBy} — double-check it's the same item.` }));
        }
        body.append(link(result.url, "Open on Toppreise →"));
        break;
      }

      case "not-found":
        body.textContent = "No match found on Toppreise.";
        if (result.searchUrl) body.append(link(result.searchUrl, "Search manually →"));
        break;

      case "no-permission":
        body.textContent =
          "Allow access to toppreise.ch: about:addons → Toppreise Check → Permissions, then reload.";
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
