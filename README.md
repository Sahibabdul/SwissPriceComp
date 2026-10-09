# Toppreise Check (Firefox add-on)

Shows a small box on Digitec and Galaxus product pages with the lowest price on toppreise.ch.

## Try it

1. Unzip this folder.
2. In Firefox open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick `manifest.json`.
4. Open any product on digitec.ch or galaxus.ch. A box appears bottom-right.

If the box says it needs access to toppreise.ch: open `about:addons` → Toppreise Check →
**Permissions** and switch on toppreise.ch, then reload the page.

Temporary add-ons are removed when Firefox restarts. Load it again the same way.

## How it works

- `content.js` reads the product (EAN, part number, name, price) from the page's JSON-LD data
  and shows the box.
- `background.js` searches Toppreise, opens the best match and reads the lowest price.
  Results are cached for 6 hours.

## Debugging

- Content script logs: the normal page console (F12).
- Background logs: `about:debugging` → **Inspect** next to the add-on.

## Likely first fix

Toppreise's HTML wasn't checked when this was written. If you always get "No match found",
open a Toppreise search page, inspect a product link, and update `PRODUCT_LINK_SELECTOR`
(and maybe `SEARCH_URL`) at the top of `background.js`.

Before publishing this, read Toppreise's terms of use about automated access.
