/* Injected by proxy server — captures and replays user interactions */
(function () {
  if (window.__RECORDER_INJECTED__) return;
  window.__RECORDER_INJECTED__ = true;

  const MOVE_THROTTLE_MS   = 50;
  const SCROLL_THROTTLE_MS = 100;

  let recording    = false;
  let startTime    = null;
  let lastMoveAt   = 0;
  let lastScrollAt = 0;

  // ── Send event to parent ──────────────────────────────────────────────────

  function emit(data) {
    if (!recording) return;
    const now = Date.now();
    if (startTime === null) startTime = now;
    try {
      window.parent.postMessage(
        { __rtype: 'RECORDER_EVENT', event: { ...data, t: now - startTime } },
        '*'
      );
    } catch {}
  }

  function btnName(b) {
    return b === 2 ? 'right' : b === 1 ? 'middle' : 'left';
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
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'))
      emit({ type: 'input', value: el.value });
  }, true);

  document.addEventListener('change', e => {
    if (e.target && e.target.tagName === 'SELECT')
      emit({ type: 'select', value: e.target.value });
  }, true);

  // ── Commands from parent ──────────────────────────────────────────────────

  window.addEventListener('message', async e => {
    const d = e.data;
    if (!d || d.__rfrom !== 'RECORDER_CTRL') return;

    switch (d.cmd) {
      case 'START':
        recording  = true;
        startTime  = null;
        lastMoveAt = 0;
        lastScrollAt = 0;
        break;

      case 'STOP':
        recording = false;
        break;

      case 'REPLAY':
        await runReplay(d.events || [], d.speedFactor || 1.0);
        try { window.parent.postMessage({ __rtype: 'REPLAY_DONE' }, '*'); } catch {}
        break;
    }
  });

  // ── In-browser replay ─────────────────────────────────────────────────────

  async function runReplay(events, speedFactor) {
    let lastT = 0;
    for (const ev of events) {
      const delay = Math.max(0, ((ev.t ?? 0) - lastT) / speedFactor);
      if (delay > 0) await sleep(delay);
      lastT = ev.t ?? 0;
      simulate(ev);
    }
  }

  function simulate(ev) {
    switch (ev.type) {
      case 'mousemove':
      case 'mousedown':
      case 'mouseup':
      case 'click':
      case 'dblclick': {
        const el = document.elementFromPoint(ev.x, ev.y);
        if (!el) break;
        if (ev.type === 'click' || ev.type === 'mousedown') el.focus?.();
        if (ev.type === 'click') { el.click?.(); }
        el.dispatchEvent(new MouseEvent(ev.type, {
          bubbles: true, cancelable: true,
          clientX: ev.x, clientY: ev.y,
          button: btnNum(ev.button),
          clickCount: ev.type === 'dblclick' ? 2 : 1,
        }));
        break;
      }
      case 'wheel': {
        const el = document.elementFromPoint(ev.x, ev.y) || document.body;
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
  try {
    window.parent.postMessage({
      __rtype: 'INJECT_READY',
      url: window.__PROXIED_URL__ || location.href,
    }, '*');
  } catch {}
})();
