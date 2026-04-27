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

    // Build a stable CSS selector for form/interactive elements.
    // Falls back to a class-based selector for buttons/links — combined with
    // the recorded label, replay can disambiguate same-class siblings.
    function getSelector(el) {
      if (!el || !el.tagName) return null;
      var tag = el.tagName.toLowerCase();
      if (el.id && /^[a-zA-Z]/.test(el.id) && !el.id.includes(' '))
        return '#' + el.id;
      if (el.name)
        return tag + '[name=' + JSON.stringify(el.name) + ']';
      var testId = el.getAttribute && el.getAttribute('data-testid');
      if (testId) return '[data-testid=' + JSON.stringify(testId) + ']';
      var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      if (ariaLabel) return tag + '[aria-label=' + JSON.stringify(ariaLabel) + ']';
      if (tag === 'input' && el.type && ['checkbox','radio'].includes(el.type))
        return el.value
          ? tag + '[type=' + JSON.stringify(el.type) + '][value=' + JSON.stringify(el.value) + ']'
          : tag + '[type=' + JSON.stringify(el.type) + ']';
      if (tag === 'input' && el.placeholder)
        return tag + '[placeholder=' + JSON.stringify(el.placeholder) + ']';
      // Class-based fallback for buttons/links (paired with label at replay)
      if (tag === 'a' && el.getAttribute && el.getAttribute('href'))
        return tag + '[href=' + JSON.stringify(el.getAttribute('href')) + ']';
      if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\\s+/).filter(function(c) {
          return c && !/^(active|selected|focus|hover|disabled)$/.test(c);
        });
        if (cls.length > 0) return tag + '.' + cls.join('.');
      }
      // Role-based fallback for non-standard tags acting as buttons/links
      var role = el.getAttribute && el.getAttribute('role');
      if (role) return tag + '[role=' + JSON.stringify(role) + ']';
      return null;
    }

    // Get visible label text for an element. Falls back to innerText for
    // buttons/links so class-based selectors can be disambiguated by label.
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
      if (tag === 'button' || tag === 'a' || tag === 'label') {
        var txt = (el.innerText || el.textContent || '').trim();
        if (txt) return txt.length > 80 ? txt.slice(0, 80) : txt;
      }
      return null;
    }

    function isInteractive(el) {
      if (!el || !el.tagName) return false;
      var tag = el.tagName.toUpperCase();
      if (['INPUT','SELECT','TEXTAREA','BUTTON','A','LABEL'].includes(tag)) return true;
      var role = el.getAttribute && el.getAttribute('role');
      return !!(role && ['button','checkbox','radio','combobox','listbox','option','menuitem','tab','link'].includes(role));
    }

    function withTarget(base, el) {
      if (!isInteractive(el)) return base;
      var sel = getSelector(el);
      var lbl = getLabel(el);
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
