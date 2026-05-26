/* Injected by proxy server — captures and replays user interactions */
(function () {
  if (window.__RECORDER_INJECTED__) return;
  window.__RECORDER_INJECTED__ = true;

  const MOVE_THROTTLE_MS   = 50;
  const SCROLL_THROTTLE_MS = 100;
  // Progress notification every N events to avoid postMessage flood
  const PROGRESS_EVERY = 5;

  let recording      = false;
  let startTime      = null;
  let lastMoveAt     = 0;
  let lastScrollAt   = 0;
  let replayAborted  = false; // Fix B4

  // ── Fix D2: only accept parent-origin messages ────────────────────────────
  const PARENT = window.parent;

  function sendToParent(msg) {
    try { PARENT.postMessage(msg, '*'); } catch {}
  }

  // ── Send captured event to parent ─────────────────────────────────────────
  function emit(data) {
    if (!recording) return;
    const now = Date.now();
    if (startTime === null) startTime = now;
    sendToParent({ __rtype: 'RECORDER_EVENT', event: { ...data, t: now - startTime } });
  }

  function btnName(b) {
    return b === 2 ? 'right' : b === 1 ? 'middle' : 'left';
  }

  // ── Fix U4: pierce shadow DOM to get true target element ──────────────────
  function elementAtPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // ── Capture listeners ─────────────────────────────────────────────────────

  document.addEventListener('click',
    e => emit({ type: 'click', x: e.clientX, y: e.clientY, button: btnName(e.button) }), true);

  document.addEventListener('dblclick',
    e => emit({ type: 'dblclick', x: e.clientX, y: e.clientY }), true);

  document.addEventListener('mousedown',
    e => emit({ type: 'mousedown', x: e.clientX, y: e.clientY, button: btnName(e.button) }), true);

  document.addEventListener('mouseup',
    e => emit({ type: 'mouseup', x: e.clientX, y: e.clientY, button: btnName(e.button) }), true);

  document.addEventListener('mousemove', e => {
    const now = Date.now();
    if (now - lastMoveAt < MOVE_THROTTLE_MS) return;
    lastMoveAt = now;
    emit({ type: 'mousemove', x: e.clientX, y: e.clientY });
  }, true);

  document.addEventListener('wheel',
    e => emit({ type: 'wheel', x: e.clientX, y: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY }),
    { capture: true, passive: true });

  window.addEventListener('scroll', () => {
    const now = Date.now();
    if (now - lastScrollAt < SCROLL_THROTTLE_MS) return;
    lastScrollAt = now;
    emit({ type: 'scroll', scrollX: window.scrollX, scrollY: window.scrollY });
  }, true);

  document.addEventListener('keydown', e => emit({
    type: 'keydown', key: e.key, code: e.code,
    ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
  }), true);

  document.addEventListener('keyup',
    e => emit({ type: 'keyup', key: e.key, code: e.code }), true);

  document.addEventListener('input', e => {
    const el = e.target;
    if (!el) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      emit({ type: 'input', value: el.value });
    } else if (el.isContentEditable) {
      // Fix U2: capture rich-text / contenteditable elements
      emit({ type: 'contenteditable', html: el.innerHTML, text: el.innerText });
    }
  }, true);

  document.addEventListener('change', e => {
    if (e.target && e.target.tagName === 'SELECT')
      emit({ type: 'select', value: e.target.value });
  }, true);

  // ── Commands from parent ──────────────────────────────────────────────────

  window.addEventListener('message', async e => {
    // Fix D2: only accept messages originating from our parent frame
    if (e.source !== PARENT) return;
    const d = e.data;
    if (!d || d.__rfrom !== 'RECORDER_CTRL') return;

    switch (d.cmd) {
      case 'START':
        recording    = true;
        startTime    = null;
        lastMoveAt   = 0;
        lastScrollAt = 0;
        break;

      case 'STOP':
        recording = false;
        break;

      case 'REPLAY':
        replayAborted = false;
        await runReplay(d.events || [], d.speedFactor || 1.0);
        sendToParent({ __rtype: 'REPLAY_DONE' });
        break;

      // Fix B4: abort in-progress replay
      case 'STOP_REPLAY':
        replayAborted = true;
        break;
    }
  });

  // ── In-browser replay ─────────────────────────────────────────────────────

  async function runReplay(events, speedFactor) {
    let lastT = 0;
    const total = events.length;

    for (let i = 0; i < total; i++) {
      if (replayAborted) break;

      const ev = events[i];
      const delay = Math.max(0, ((ev.t ?? 0) - lastT) / speedFactor);
      if (delay > 0) await sleep(delay);
      lastT = ev.t ?? 0;

      simulate(ev);

      // Fix D5: send real progress (throttled to avoid message flood)
      if (i % PROGRESS_EVERY === 0 || i === total - 1) {
        sendToParent({ __rtype: 'REPLAY_PROGRESS', done: i + 1, total });
      }
    }
  }

  function simulate(ev) {
    switch (ev.type) {
      case 'mousemove':
      case 'mousedown':
      case 'mouseup':
      case 'click':
      case 'dblclick': {
        // Fix U4: use shadow-DOM-piercing helper
        const el = elementAtPoint(ev.x, ev.y);
        if (!el) break;
        if (ev.type === 'click' || ev.type === 'mousedown') el.focus?.();
        if (ev.type === 'click') el.click?.();
        el.dispatchEvent(new MouseEvent(ev.type, {
          bubbles: true, cancelable: true,
          clientX: ev.x, clientY: ev.y,
          button: btnNum(ev.button),
          detail: ev.type === 'dblclick' ? 2 : 1,
        }));
        break;
      }
      case 'wheel': {
        const el = elementAtPoint(ev.x, ev.y) || document.body;
        el.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true,
          deltaX: ev.deltaX, deltaY: ev.deltaY,
        }));
        break;
      }
      case 'scroll':
        window.scrollTo(ev.scrollX, ev.scrollY);
        break;

      case 'keydown':
      case 'keyup': {
        const el = document.activeElement || document.body;
        el.dispatchEvent(new KeyboardEvent(ev.type, {
          bubbles: true, cancelable: true,
          key: ev.key, code: ev.code,
          ctrlKey: !!ev.ctrl, shiftKey: !!ev.shift,
          altKey: !!ev.alt, metaKey: !!ev.meta,
        }));
        break;
      }
      case 'input': {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          el.value = ev.value;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
      }
      // Fix U2: replay contenteditable
      case 'contenteditable': {
        const el = document.activeElement;
        if (el && el.isContentEditable) {
          el.innerHTML = ev.html;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
      }
      case 'select': {
        const el = document.activeElement;
        if (el && el.tagName === 'SELECT') {
          el.value = ev.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
      }
    }
  }

  function btnNum(b) {
    return b === 'right' ? 2 : b === 'middle' ? 1 : 0;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // Notify parent that this page is ready
  sendToParent({
    __rtype: 'INJECT_READY',
    url: window.__PROXIED_URL__ || location.href,
  });
})();
