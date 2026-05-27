"use strict";

const { applyBaseUrl } = require("./url");

const BTN = (b) => (b === "right" ? "right" : b === "middle" ? "middle" : "left");

// Pick the element matching `selector` whose visible text equals `label`,
// falling back to the first match if none does. Pierces Shadow DOM (open
// roots, recursive) and traverses iframes so web-component pages and pages
// with embedded frames resolve selectors correctly.
async function pickByLabelOrFirst(page, selector, label) {
  // 1. Main frame with Shadow DOM piercing
  try {
    const handle = await page.evaluateHandle(
      (sel, lbl) => {
        function collect(root, out) {
          try { for (const e of root.querySelectorAll(sel)) out.push(e); } catch {}
          for (const el of root.querySelectorAll("*"))
            if (el.shadowRoot) collect(el.shadowRoot, out);
        }
        const all = [];
        collect(document, all);
        if (all.length === 0) return null;
        if (all.length === 1 || !lbl) return all[0];
        // Prefer VISIBLE element with matching label (important when multiple
        // El Plus components share the same option labels, e.g., 5 selects
        // all with "Option 1" — only the open dropdown's item is visible).
        var firstAnyMatch = null;
        for (var _i = 0; _i < all.length; _i++) {
          var _e = all[_i];
          var _txt = (_e.innerText || _e.textContent || "").trim();
          if (_txt !== lbl) continue;
          var _r = _e.getBoundingClientRect();
          if (_r.width > 0 && _r.height > 0) return _e;
          if (!firstAnyMatch) firstAnyMatch = _e;
        }
        return firstAnyMatch || all[0];
      },
      selector,
      label,
    );
    const el = handle.asElement();
    if (el) {
      const isNull = await el.evaluate((n) => n === null).catch(() => false);
      if (!isNull) return el;
    }
    await handle.dispose().catch(() => {});
  } catch {}

  // 2. Child frames (iframes)
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const handles = await frame.$$(selector);
      if (handles.length === 0) continue;
      if (handles.length === 1 || !label) return handles[0];
      for (const h of handles) {
        const txt = await h.evaluate((e) => (e.innerText || "").trim());
        if (txt === label) return h;
      }
      return handles[0];
    } catch {}
  }
  return null;
}

// If the target element exists in DOM but is currently hidden (typical of
// hover-revealed dropdown menus), find the closest visible ancestor that
// looks like a menu trigger (aria-haspopup, has hidden submenu children, or
// is a top-level nav item) and hover it. Returns true if a hover happened.
async function tryHoverAncestorTrigger(page, selector) {
  const triggerInfo = await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    if (!target) return null;
    const visible = (() => {
      const r = target.getBoundingClientRect();
      const s = window.getComputedStyle(target);
      return r.width > 0 && r.height > 0 &&
             s.visibility !== "hidden" && s.display !== "none";
    })();
    if (visible) return null;
    let cur = target.parentElement;
    while (cur && cur !== document.body) {
      const r = cur.getBoundingClientRect();
      const s = window.getComputedStyle(cur);
      const isVisible = r.width > 0 && r.height > 0 &&
                        s.visibility !== "hidden" && s.display !== "none";
      if (isVisible) {
        const haspopup = cur.getAttribute("aria-haspopup");
        const cls = (cur.className || "").toString();
        if (haspopup === "true" || haspopup === "menu" ||
            /\b(has-(dropdown|menu|sub)|menu-item|gnb|lnb|nav-item)\b/.test(cls) ||
            cur.querySelector(":scope > ul, :scope > .submenu, :scope > .sub-menu, :scope > [class*='dropdown' i]")) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }, selector);
  if (!triggerInfo) return false;
  await page.mouse.move(triggerInfo.x, triggerInfo.y);
  await new Promise((r) => setTimeout(r, 150));
  return true;
}

// Keys that have no Puppeteer equivalent and must be silently skipped.
// "Process"    — IME 조합 중 키 (한국어·일본어·중국어 입력 시 발생)
// "Unidentified" — 브라우저가 식별 불가한 키
// "Dead"       — 악센트 조합 키 (프랑스어 등)
// "Compose"    — Linux Compose 키
const SKIP_KEYS = new Set(["Process", "Unidentified", "Dead", "Compose", "OS"]);

// Events whose dispatch is followed by a network-idle wait (they typically
// trigger HTTP requests).
const NETWORK_EVTS = new Set(["navigate", "click", "dblclick"]);

// Events that don't naturally trigger network activity — replayed without
// the post-event idle wait.
const NO_DELAY_EVTS = new Set([
  "keydown", "keyup", "input", "scroll", "wheel", "contenteditable",
]);

// Dispatch a recorded event on a Puppeteer page.
async function dispatchEvent(page, ev, baseUrl, fast = false) {
  switch (ev.type) {
    case "navigate":
      await page.goto(applyBaseUrl(ev.url, baseUrl), {
        waitUntil: fast ? "domcontentloaded" : "networkidle2",
        timeout: 30000,
      });
      break;
    case "click":
      // If this is an El Plus dropdown option, open the parent select first
      if (ev.elSelectSelector) {
        try {
          // Detect open state via visible dropdown items — more reliable than
          // is-focus/is-open classes which vary across El Plus versions.
          const isOpen = await page.evaluate(() => {
            var items = document.querySelectorAll(".el-select-dropdown__item");
            for (var _i = 0; _i < items.length; _i++) {
              var _r = items[_i].getBoundingClientRect();
              if (_r.width > 0 && _r.height > 0) return true;
            }
            return false;
          }).catch(() => false);
          if (!isOpen) {
            // Click the wrapper directly (same as recording-time clickSelect helper)
            await page.evaluate((sel) => {
              var el = document.querySelector(sel);
              if (!el) return;
              var wrapper = el.querySelector(".el-select__wrapper") || el;
              wrapper.click();
            }, ev.elSelectSelector);
            // Poll until at least one dropdown item is visible — avoids the
            // fixed-delay race where 300ms was shorter than the open animation.
            await page.waitForFunction(() => {
              var items = document.querySelectorAll(".el-select-dropdown__item");
              for (var i = 0; i < items.length; i++) {
                var r = items[i].getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return true;
              }
              return false;
            }, { timeout: 3000 }).catch(() => {});
          }
        } catch {}
      }
      if (ev.selector) {
        try {
          let el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          // Hover-revealed menu items: if the element exists but is hidden,
          // hover an ancestor menu trigger and retry.
          if (el) {
            const visible = await el.evaluate((e) => {
              const r = e.getBoundingClientRect();
              const s = window.getComputedStyle(e);
              return r.width > 0 && r.height > 0 &&
                     s.visibility !== "hidden" && s.display !== "none";
            }).catch(() => true);
            if (!visible && await tryHoverAncestorTrigger(page, ev.selector)) {
              el = await pickByLabelOrFirst(page, ev.selector, ev.label);
            }
          }
          if (el) {
            // Scroll the option into view within the dropdown list before clicking.
            // Handles the case where the target option is below the dropdown's
            // visible fold and requires scrolling to become interactable.
            if (ev.elSelectSelector)
              await el.evaluate((e) => e.scrollIntoView({ block: "nearest" })).catch(() => {});
            await el.click();
            break;
          }
        } catch {}
      }
      await page.mouse.click(ev.x, ev.y, { button: BTN(ev.button) });
      break;
    case "dblclick":
      if (ev.selector) {
        try {
          const el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          if (el) { await el.click({ clickCount: 2 }); break; }
        } catch {}
      }
      await page.mouse.click(ev.x, ev.y, { clickCount: 2 });
      break;
    case "hover":
      if (ev.selector) {
        try {
          const el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          if (el) { await el.hover(); break; }
        } catch {}
      }
      if (typeof ev.x === "number" && typeof ev.y === "number")
        await page.mouse.move(ev.x, ev.y);
      break;
    case "wheel":
      await page.mouse.wheel({ deltaX: ev.deltaX, deltaY: ev.deltaY });
      break;
    case "scroll":
      await page.evaluate((x, y) => window.scrollTo(x, y), ev.scrollX, ev.scrollY);
      break;
    case "keydown": {
      const key = ev.key === " " ? "Space" : ev.key;
      if (!SKIP_KEYS.has(key)) {
        try { await page.keyboard.down(key); } catch {}
      }
      break;
    }
    case "keyup": {
      const key = ev.key === " " ? "Space" : ev.key;
      if (!SKIP_KEYS.has(key)) {
        try { await page.keyboard.up(key); } catch {}
      }
      break;
    }
    case "input":
      if (ev.selector) {
        try {
          const el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          if (el) {
            await el.click({ clickCount: 3 });
            await el.type(ev.value ?? "");
            break;
          }
        } catch {}
      }
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.type(ev.value ?? "");
      break;
    case "select":
      if (ev.selector) {
        try {
          const el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          if (el) {
            await el.evaluate((node, v) => {
              node.value = v;
              node.dispatchEvent(new Event("change", { bubbles: true }));
            }, ev.value);
            break;
          }
        } catch {}
      }
      await page.evaluate((v) => {
        const el = document.activeElement;
        if (el && el.tagName === "SELECT") {
          el.value = v;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, ev.value);
      break;
    case "check":
      if (ev.selector) {
        try {
          const el = await pickByLabelOrFirst(page, ev.selector, ev.label);
          if (el) {
            // El Plus checkbox/radio: the recorded selector points to the hidden
            // <input class="el-checkbox__original"> (opacity:0 / position:absolute).
            // Puppeteer refuses to click invisible elements, so we locate the
            // nearest visible clickable ancestor and use its current viewport center.
            const info = await el.evaluate((input) => {
              const s = window.getComputedStyle(input);
              const hidden =
                parseFloat(s.opacity) < 0.1 ||
                s.visibility === "hidden"     ||
                s.display === "none"          ||
                (s.position === "absolute" && input.offsetWidth === 0 && input.offsetHeight === 0);

              const cur = input.indeterminate ? null : input.checked;

              if (!hidden) return { cur, cx: null, cy: null };

              // Walk up to find the visible El Plus wrapper label or the inner span
              const candidates = [
                input.closest("label.el-checkbox, label.el-radio, label.el-checkbox-button, label.el-radio-button"),
                input.parentElement && input.parentElement.querySelector(".el-checkbox__inner, .el-radio__inner"),
                input.parentElement,
              ];
              for (const c of candidates) {
                if (!c) continue;
                const r = c.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  c.scrollIntoView({ block: "nearest" });
                  const r2 = c.getBoundingClientRect();
                  return { cur, cx: r2.left + r2.width / 2, cy: r2.top + r2.height / 2 };
                }
              }
              return { cur, cx: null, cy: null };
            });

            if (info.cur !== ev.checked) {
              if (info.cx !== null) {
                await page.mouse.click(info.cx, info.cy);
              } else {
                await el.click();
              }
            }
            break;
          }
        } catch {}
      }
      await page.mouse.click(ev.x ?? 0, ev.y ?? 0);
      break;
    case "contenteditable":
      await page.evaluate((h) => {
        if (document.activeElement) document.activeElement.innerHTML = h;
      }, ev.html);
      break;
  }
}

async function waitNetworkIdle(page, timeout, idleTime = 500) {
  try {
    await page.waitForNetworkIdle({ idleTime, timeout });
  } catch {}
}

module.exports = {
  BTN,
  NETWORK_EVTS,
  NO_DELAY_EVTS,
  pickByLabelOrFirst,
  dispatchEvent,
  waitNetworkIdle,
};
