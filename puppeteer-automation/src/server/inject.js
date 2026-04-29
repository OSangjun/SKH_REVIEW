"use strict";

/**
 * Capture script injected into every page via puppeteer's
 * `evaluateOnNewDocument`. Runs in the page's JS context (not Node) and
 * forwards events to Node via the exposed `__captureEvent` / `__captureToast`
 * functions.
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

    // ── Element Plus detection ────────────────────────────────────────────────
    // Component root classes (the top-level wrapper div of each El Plus component).
    var EL_COMP_RE = /\\bel-(select|input|checkbox|radio|switch|cascader|autocomplete|rate|slider|color-picker|date-editor|time-picker|time-select|input-number)\\b/;
    // Popup option/item classes (rendered in a teleported popper outside the component).
    var EL_OPT_RE  = /\\bel-(select-dropdown__item|dropdown-menu__item|cascader-node)\\b/;

    function isInteractive(el) {
      if (!el || !el.tagName) return false;
      var tag = el.tagName.toUpperCase();
      if (['INPUT','SELECT','TEXTAREA','BUTTON','A','LABEL'].includes(tag)) return true;
      var role = el.getAttribute && el.getAttribute('role');
      if (role && ['button','checkbox','radio','combobox','listbox','option','menuitem',
                   'tab','link','switch','menuitemcheckbox','menuitemradio'].includes(role)) return true;
      var cls = typeof el.className === 'string' ? el.className : '';
      return EL_COMP_RE.test(cls) || EL_OPT_RE.test(cls);
    }

    // Walk up the DOM to find the best interactive target.
    // For El Plus: prefer the outermost component root so that clicking inside
    // an el-select returns the el-select div, not the inner el-input or <input>.
    function nearestInteractive(el) {
      var cur = el;
      var nativeFallback = null;
      var elPlusRoot = null;
      for (var i = 0; i < 10; i++) {
        if (!cur || cur === document.documentElement) break;
        var cls = typeof cur.className === 'string' ? cur.className : '';
        // Popup option items → return immediately (they are not inside the component)
        if (EL_OPT_RE.test(cls)) return cur;
        // El Plus component root → keep walking to find outermost ancestor
        if (EL_COMP_RE.test(cls)) { elPlusRoot = cur; cur = cur.parentElement; continue; }
        // Native interactive → remember first found as fallback
        if (!nativeFallback) {
          var tag = cur.tagName && cur.tagName.toUpperCase();
          if (['INPUT','SELECT','TEXTAREA','BUTTON','A','LABEL'].includes(tag)) {
            nativeFallback = cur;
          } else {
            var role = cur.getAttribute && cur.getAttribute('role');
            if (role && ['button','checkbox','radio','combobox','listbox','option','menuitem',
                         'tab','link','switch','menuitemcheckbox','menuitemradio'].includes(role))
              nativeFallback = cur;
          }
        }
        cur = cur.parentElement;
      }
      return elPlusRoot || nativeFallback || el;
    }

    // nth-of-type path anchored at the nearest stable ancestor with an ID.
    function nthChildPath(el) {
      var parts = [];
      var cur = el;
      for (var depth = 0; depth < 8; depth++) {
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

    function isAutoId(id) {
      if (!id) return true;
      if (!/^[a-zA-Z]/.test(id) || id.includes(' ')) return true;
      if (/^(rc-|ant-|mat-|mdc-|cdk-|ng-|vue-|ember|p-|:r)/.test(id)) return true;
      if (/[0-9]{3,}/.test(id)) return true;
      return false;
    }

    // Get El Plus form-item label text for an element inside .el-form-item.
    function getElFormLabel(el) {
      var cur = el;
      for (var i = 0; i < 8; i++) {
        if (!cur || cur === document.documentElement) break;
        if (cur.classList && cur.classList.contains('el-form-item')) {
          var lbl = cur.querySelector('.el-form-item__label');
          return lbl ? (lbl.textContent || '').trim().replace(/:$/, '').trim() || null : null;
        }
        cur = cur.parentElement;
      }
      return null;
    }

    // Find the el-select that currently has its dropdown open.
    // El Plus adds is-focus to the active select's root div.
    function findAssociatedSelect(optionEl) {
      var active = document.querySelector('.el-select.is-focus');
      if (active) return getSelector(active);
      // Fallback: walk up from option to popup, then find trigger via aria
      var popup = optionEl;
      for (var i = 0; i < 6; i++) {
        if (!popup) break;
        if (popup.classList && (popup.classList.contains('el-select__popper') ||
            popup.classList.contains('el-select-dropdown'))) {
          var triggerId = popup.getAttribute('aria-labelledby');
          if (triggerId) {
            var trigEl = document.getElementById(triggerId);
            if (trigEl) {
              var sel = trigEl.closest && trigEl.closest('.el-select');
              if (sel) return getSelector(sel);
            }
          }
          break;
        }
        popup = popup.parentElement;
      }
      return null;
    }

    // Build the most stable CSS selector for an element.
    function getSelector(el) {
      if (!el || !el.tagName) return null;
      var tag = el.tagName.toLowerCase();
      var cls = typeof el.className === 'string' ? el.className : '';

      // ── El Plus popup option → generic class; label text disambiguates at replay
      if (EL_OPT_RE.test(cls)) {
        return '.' + EL_OPT_RE.exec(cls)[0];
      }

      // ── El Plus component root → contextual selector ───────────────────────
      if (EL_COMP_RE.test(cls)) {
        var elCls = EL_COMP_RE.exec(cls)[0];
        // 1. Stable ID
        if (!isAutoId(el.id)) return '#' + el.id;
        // 2. data-testid / data-cy / data-test
        var testAttr2 = ['data-testid','data-cy','data-test'];
        for (var tj = 0; tj < testAttr2.length; tj++) {
          var tv2 = el.getAttribute && el.getAttribute(testAttr2[tj]);
          if (tv2) return '[' + testAttr2[tj] + '=' + JSON.stringify(tv2) + ']';
        }
        // 3. aria-label on the component root
        var aria2 = el.getAttribute && el.getAttribute('aria-label');
        if (aria2) return '.' + elCls + '[aria-label=' + JSON.stringify(aria2) + ']';
        // 4. Form-item label context (most reliable for El Plus forms)
        var fLabel = getElFormLabel(el);
        if (fLabel) {
          var fi = el.closest && el.closest('.el-form-item');
          if (fi && fi.parentElement) {
            var childIdx = Array.prototype.indexOf.call(fi.parentElement.children, fi) + 1;
            if (childIdx > 0) {
              var cand = '.el-form-item:nth-child(' + childIdx + ') .' + elCls;
              try { if (document.querySelectorAll(cand).length === 1) return cand; } catch {}
            }
          }
        }
        // 5. Placeholder inside component (el-input / el-select)
        var inner = el.querySelector && el.querySelector('input[placeholder]');
        if (inner && inner.placeholder) {
          var phSel = '.' + elCls + ' input[placeholder=' + JSON.stringify(inner.placeholder) + ']';
          try { if (document.querySelectorAll(phSel).length === 1) return phSel; } catch {}
        }
        // 6. nth-child path fallback
        return nthChildPath(el) || ('.' + elCls);
      }

      // ── Standard selector logic ────────────────────────────────────────────
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

      // 7. href (anchor)
      var href = tag === 'a' && el.getAttribute && el.getAttribute('href');
      if (href && href !== '#' && href.length < 120)
        return 'a[href=' + JSON.stringify(href) + ']';

      // 8. Unique class combination (skip volatile state classes)
      var VOLATILE = /^(active|selected|focus|focused|hover|disabled|show|hide|visible|open|closed|is-active|is-open|is-selected|is-disabled|loading|checked|__rfRec__)$/;
      if (el.className && typeof el.className === 'string') {
        var cls2 = el.className.trim().split(/\\s+/).filter(function(c) {
          return c && !VOLATILE.test(c);
        });
        if (cls2.length > 0) {
          var clsSel = tag + '.' + cls2.join('.');
          try { if (document.querySelectorAll(clsSel).length === 1) return clsSel; } catch {}
        }
      }

      // 9. role (unique check)
      var role = el.getAttribute && el.getAttribute('role');
      if (role) {
        var roleSel = tag + '[role=' + JSON.stringify(role) + ']';
        try { if (document.querySelectorAll(roleSel).length === 1) return roleSel; } catch {}
      }

      // 10. nth-child path (last resort)
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
      var cls = typeof el.className === 'string' ? el.className : '';
      // El Plus: option items and component labels
      if (EL_OPT_RE.test(cls)) {
        var optTxt = (el.innerText || el.textContent || '').trim();
        if (optTxt && optTxt.length <= 80) return optTxt;
      }
      if (EL_COMP_RE.test(cls)) {
        var fLabel = getElFormLabel(el);
        if (fLabel) return fLabel;
        // Checkbox/radio inner label
        var innerLbl = el.querySelector && el.querySelector(
          '.el-checkbox__label,.el-radio__label,.el-checkbox-button__inner,.el-radio-button__inner'
        );
        if (innerLbl) {
          var innerTxt = (innerLbl.innerText || innerLbl.textContent || '').trim();
          if (innerTxt) return innerTxt;
        }
      }
      var tag = el.tagName && el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'label'
          || (el.getAttribute && el.getAttribute('role') === 'button')) {
        var txt = (el.innerText || el.textContent || '').trim();
        if (txt) return txt.length > 80 ? txt.slice(0, 80) : txt;
      }
      return null;
    }

    // Walk up the frame chain summing iframe rects to convert iframe-local
    // clientX/Y to main-page viewport coordinates. Cross-origin frames
    // (where frameElement is null) terminate the walk gracefully.
    function getFrameOffset() {
      var x = 0, y = 0;
      try {
        var win = window;
        while (win.frameElement && win !== win.top) {
          var rect = win.frameElement.getBoundingClientRect();
          x += rect.left;
          y += rect.top;
          win = win.parent;
        }
      } catch (ignore) {}
      return { x: x, y: y };
    }

    function withTarget(base, el) {
      var target = nearestInteractive(el);
      var sel = getSelector(target);
      var lbl = getLabel(target);
      if (sel) base.selector = sel;
      if (lbl) base.label    = lbl;
      return base;
    }

    // Briefly highlight the target element with a green glow during recording
    // so the user can see which element was captured.
    function flashTarget(el, isInput) {
      if (!el || !el.classList) return;
      if (!document.getElementById('__rec-flash-style__')) {
        var s = document.createElement('style');
        s.id = '__rec-flash-style__';
        s.textContent =
          '@keyframes __rfRec__ {' +
            '0%  {outline:3px solid rgba(16,185,129,0)  !important;outline-offset:4px !important;background-color:rgba(16,185,129,0)   !important}' +
            '20% {outline:3px solid rgba(16,185,129,1)  !important;outline-offset:4px !important;background-color:rgba(16,185,129,0.2) !important}' +
            '80% {outline:3px solid rgba(16,185,129,.8) !important;outline-offset:4px !important;background-color:rgba(16,185,129,0.1) !important}' +
            '100%{outline:3px solid rgba(16,185,129,0)  !important;outline-offset:4px !important;background-color:rgba(16,185,129,0)   !important}' +
          '}' +
          '.__rfRec__{animation:__rfRec__ .55s ease forwards !important}';
        document.head.appendChild(s);
      }
      el.classList.remove('__rfRec__');
      void el.offsetWidth;
      el.classList.add('__rfRec__');
      setTimeout(function() { if (el) el.classList.remove('__rfRec__'); }, 600);
    }

    document.addEventListener('click', e => {
      var off = getFrameOffset();
      var base = { x: e.clientX + off.x, y: e.clientY + off.y, button: btn(e.button) };
      // For El Plus dropdown options, record which select triggered this popup
      var rawTarget = nearestInteractive(e.target);
      var rawCls = typeof rawTarget.className === 'string' ? rawTarget.className : '';
      if (EL_OPT_RE.test(rawCls)) {
        var assocSel = findAssociatedSelect(rawTarget);
        if (assocSel) base.elSelectSelector = assocSel;
      }
      var clickEvt = withTarget(base, e.target); // capture selector before flash class is added
      flashTarget(rawTarget);
      cap('click', clickEvt);
    }, true);

    document.addEventListener('dblclick', e => {
      var off = getFrameOffset();
      cap('dblclick', withTarget({ x: e.clientX + off.x, y: e.clientY + off.y }, e.target));
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
        flashTarget(nearestInteractive(el));
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
        flashTarget(nearestInteractive(el));
        cap('select', withTarget({ value: el.value, optLabel: optLabel }, el));
      } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        flashTarget(nearestInteractive(el));
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
