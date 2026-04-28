"use strict";

/**
 * Capture script injected into every page via puppeteer's
 * `evaluateOnNewDocument`. Runs in the page's JS context (not Node) and
 * forwards events to Node via the exposed `__captureEvent` / `__captureToast`
 * functions.
 *
 * Exported as a string because puppeteer requires a string or a function
 * reference here, and we keep it as a function-returning-a-string so we can
 * extend it later with build-time substitutions if needed.
 */
function buildCaptureScript() {
  return `(function () {
    if (window.__CDP_CAPTURE_ACTIVE__) return;
    window.__CDP_CAPTURE_ACTIVE__ = true;

    const cap = window.__captureEvent;
    if (!cap) return;

    const SCROLL_THROTTLE = 100;
    let lastScroll = 0;

    function btn(b) { return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'; }

    function isInteractive(el) {
      if (!el || !el.tagName) return false;
      var tag = el.tagName.toUpperCase();
      if (['INPUT','SELECT','TEXTAREA','BUTTON','A','LABEL'].includes(tag)) return true;
      var role = el.getAttribute && el.getAttribute('role');
      return !!(role && ['button','checkbox','radio','combobox','listbox','option','menuitem','tab','link','switch','menuitemcheckbox','menuitemradio'].includes(role));
    }

    // Walk up the DOM (up to 5 levels) to find the nearest interactive
    // ancestor. Returns the original element when none is found.
    function nearestInteractive(el) {
      var cur = el;
      for (var i = 0; i < 5; i++) {
        if (!cur || cur === document.documentElement) break;
        if (isInteractive(cur)) return cur;
        cur = cur.parentElement;
      }
      return el;
    }

    // nth-of-type path anchored at the nearest stable ancestor with an ID.
    // Last-resort fallback when attribute-based selectors are non-unique.
    function nthChildPath(el) {
      var parts = [];
      var cur = el;
      for (var depth = 0; depth < 6; depth++) {
        if (!cur || cur === document.documentElement) break;
        var tag = cur.tagName.toLowerCase();
        var parent = cur.parentElement;
        if (!parent) break;
        var sibs = Array.prototype.filter.call(parent.children, function(c) {
          return c.tagName === cur.tagName;
        });
        var part = sibs.length > 1
          ? tag + ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')'
          : tag;
        parts.unshift(part);
        // Anchor at nearest stable parent ID
        if (parent.id && /^[a-zA-Z][\\w-]{0,49}$/.test(parent.id)
            && !/^(rc-|ant-|mat-|mdc-|cdk-|ng-|vue-|ember|p-|r[0-9])/.test(parent.id)
            && !/[0-9]{3,}/.test(parent.id)) {
          parts.unshift('#' + parent.id);
          return parts.join(' > ');
        }
        cur = parent;
      }
      return parts.length ? parts.join(' > ') : null;
    }

    // Returns true if the ID looks auto-generated (framework / numeric).
    function isAutoId(id) {
      if (!id) return true;
      if (!/^[a-zA-Z]/.test(id) || id.includes(' ')) return true;
      if (/^(rc-|ant-|mat-|mdc-|cdk-|ng-|vue-|ember|p-|:r)/.test(id)) return true;
      if (/[0-9]{3,}/.test(id)) return true; // 3+ consecutive digits = likely generated
      return false;
    }

    // Build the most stable CSS selector for an element.
    // Priority: id > data-testid > name > aria-label > type/placeholder/href
    //           > unique class combo > role > nth-child path.
    function getSelector(el) {
      if (!el || !el.tagName) return null;
      var tag = el.tagName.toLowerCase();

      // 1. Stable ID
      if (!isAutoId(el.id)) return '#' + el.id;

      // 2. data-testid / data-cy / data-test
      var testAttr = ['data-testid','data-cy','data-test'];
      for (var ti = 0; ti < testAttr.length; ti++) {
        var tv = el.getAttribute && el.getAttribute(testAttr[ti]);
        if (tv) return '[' + testAttr[ti] + '=' + JSON.stringify(tv) + ']';
      }

      // 3. name (form elements)
      if (el.name) return tag + '[name=' + JSON.stringify(el.name) + ']';

      // 4. aria-label
      var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      if (ariaLabel) return tag + '[aria-label=' + JSON.stringify(ariaLabel) + ']';

      // 5. type + value (checkbox / radio)
      if (tag === 'input' && el.type && (el.type === 'checkbox' || el.type === 'radio'))
        return el.value
          ? tag + '[type=' + JSON.stringify(el.type) + '][value=' + JSON.stringify(el.value) + ']'
          : tag + '[type=' + JSON.stringify(el.type) + ']';

      // 6. placeholder
      if ((tag === 'input' || tag === 'textarea') && el.placeholder)
        return tag + '[placeholder=' + JSON.stringify(el.placeholder) + ']';

      // 7. href (anchor — skip bare hashes and very long dynamic URLs)
      var href = tag === 'a' && el.getAttribute && el.getAttribute('href');
      if (href && href !== '#' && href.length < 120)
        return 'a[href=' + JSON.stringify(href) + ']';

      // 8. Unique class combination (skip volatile state classes)
      var VOLATILE = /^(active|selected|focus|focused|hover|disabled|show|hide|visible|open|closed|is-active|is-open|is-selected|is-disabled|loading|checked)$/;
      if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\\s+/).filter(function(c) {
          return c && !VOLATILE.test(c);
        });
        if (cls.length > 0) {
          var clsSel = tag + '.' + cls.join('.');
          try { if (document.querySelectorAll(clsSel).length === 1) return clsSel; } catch {}
        }
      }

      // 9. role (unique check)
      var role = el.getAttribute && el.getAttribute('role');
      if (role) {
        var roleSel = tag + '[role=' + JSON.stringify(role) + ']';
        try { if (document.querySelectorAll(roleSel).length === 1) return roleSel; } catch {}
      }

      // 10. nth-child path (last resort — always returns something)
      return nthChildPath(el);
    }

    // Get visible label text for an element.
    function getLabel(el) {
      if (!el) return null;
      var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
      if (labelledBy) {
        var lbEl = document.getElementById(labelledBy);
        if (lbEl) return (lbEl.innerText || lbEl.textContent || '').trim() || null;
      }
      if (el.id) {
        var lEl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
        if (lEl) return (lEl.innerText || lEl.textContent || '').trim() || null;
      }
      if (el.placeholder) return el.placeholder;
      var tag = el.tagName && el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'label'
          || (el.getAttribute && el.getAttribute('role') === 'button')) {
        var txt = (el.innerText || el.textContent || '').trim();
        if (txt) return txt.length > 80 ? txt.slice(0, 80) : txt;
      }
      return null;
    }

    // Resolve the best target for a click/interaction event:
    // walk up to the nearest interactive ancestor, then record its selector
    // and label. Always attaches selector (even for non-interactive targets).
    function withTarget(base, el) {
      var target = nearestInteractive(el);
      var sel = getSelector(target);
      var lbl = getLabel(target);
      if (sel) base.selector = sel;
      if (lbl) base.label    = lbl;
      return base;
    }

    document.addEventListener('click', e => {
      cap('click', withTarget({ x: e.clientX, y: e.clientY, button: btn(e.button) }, e.target));
    }, true);
    document.addEventListener('dblclick', e => {
      cap('dblclick', withTarget({ x: e.clientX, y: e.clientY }, e.target));
    }, true);
    document.addEventListener('wheel',
      e => cap('wheel', { x: e.clientX, y: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY }),
      { capture: true, passive: true });

    window.addEventListener('scroll', () => {
      const now = Date.now();
      if (now - lastScroll < SCROLL_THROTTLE) return;
      lastScroll = now;
      cap('scroll', { scrollX: window.scrollX, scrollY: window.scrollY });
    }, true);

    document.addEventListener('keydown',
      e => cap('keydown', {
        key: e.key, code: e.code,
        ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
      }), true);
    document.addEventListener('keyup',
      e => cap('keyup', { key: e.key, code: e.code }), true);

    document.addEventListener('input', e => {
      var el = e.target;
      if (!el) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        cap('input', withTarget({ value: el.value }, el));
      } else if (el.isContentEditable) {
        cap('contenteditable', { html: el.innerHTML, text: el.innerText });
      }
    }, true);

    document.addEventListener('change', e => {
      var el = e.target;
      if (!el) return;
      if (el.tagName === 'SELECT') {
        var optLabel = el.options && el.selectedIndex >= 0
          ? (el.options[el.selectedIndex].text || '').trim() : '';
        cap('select', withTarget({ value: el.value, optLabel: optLabel }, el));
      } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        cap('check', withTarget({ checked: el.checked, value: el.value }, el));
      }
    }, true);

    // Toast / notification observer (role="alert" or role="status")
    const _toastSeen = new WeakSet();
    const _toastObs  = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          var els = (node.matches && node.matches('[role="alert"],[role="status"]'))
            ? [node]
            : (node.querySelectorAll
                ? Array.prototype.slice.call(node.querySelectorAll('[role="alert"],[role="status"]'))
                : []);
          for (var k = 0; k < els.length; k++) {
            var el = els[k];
            if (_toastSeen.has(el)) continue;
            _toastSeen.add(el);
            var text = (el.innerText || el.textContent || '').trim();
            if (text) cap('toast', { text: text });
          }
        }
      }
    });
    (function startToastObs() {
      if (document.body) _toastObs.observe(document.body, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', startToastObs);
    })();
  })();`;
}

const TOAST_OBSERVER_SCRIPT = `(function() {
  if (window.__CDP_TOAST_OBSERVER__) return;
  window.__CDP_TOAST_OBSERVER__ = true;
  var seen = new WeakSet();
  var obs  = new MutationObserver(function(muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        var els = (node.matches && node.matches('[role="alert"],[role="status"]'))
          ? [node]
          : (node.querySelectorAll
              ? Array.prototype.slice.call(node.querySelectorAll('[role="alert"],[role="status"]'))
              : []);
        for (var k = 0; k < els.length; k++) {
          var el = els[k];
          if (seen.has(el)) continue;
          seen.add(el);
          var text = (el.innerText || el.textContent || '').trim();
          if (text && window.__captureToast) window.__captureToast(text);
        }
      }
    }
  });
  function start() {
    if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

module.exports = { buildCaptureScript, TOAST_OBSERVER_SCRIPT };
