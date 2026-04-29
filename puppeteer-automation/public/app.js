/* Browser Automation Tool — WebSocket + Canvas Frontend */
(function () {
  'use strict';

  // ── Icon helpers ──────────────────────────────────────────────────────────────
  // Resolve <ANY data-icon="name"> elements into inline SVG. Called once on
  // load and again after dynamic renders (renderList, renderUrlTree, …).
  const ICON = (name, cls) => (window.ICONS && window.ICONS[name]) ? window.ICONS[name](cls) : '';
  function hydrateIcons(root) {
    root = root || document;
    const els = root.querySelectorAll('[data-icon]');
    for (const el of els) {
      const name = el.dataset.icon;
      const built = ICON(name);
      if (!built) continue;
      // Replace text content of element with the SVG. Idempotent — empty
      // out then set so re-hydration on the same element is safe.
      el.innerHTML = built;
      // Mark as hydrated so we can debug double-hydration without surprises
      el.dataset.iconHydrated = '1';
    }
  }
  // Initial pass — on DOMContentLoaded the script runs at end of body so
  // elements already exist; just hydrate now.
  hydrateIcons();

  // ── DOM refs ──────────────────────────────────────────────────────────────────
  const urlInput      = document.getElementById('url-input');
  const goBtn         = document.getElementById('go-btn');
  const recordBtn     = document.getElementById('record-btn');
  const replayBtn        = document.getElementById('replay-btn');
  const speedSelect      = document.getElementById('speed-select');
  const httpCompareChk   = document.getElementById('http-compare-chk');
  const mockReplayChk    = document.getElementById('mock-replay-chk');
  const canvas        = document.getElementById('browser-canvas');
  const ctx           = canvas.getContext('2d');
  const frameUrlLabel = document.getElementById('frame-url');
  const recBadge      = document.getElementById('rec-badge');
  const statusText    = document.getElementById('status-text');
  const recList       = document.getElementById('rec-list');
  const recCount      = document.getElementById('rec-count');
  const ovName        = document.getElementById('ov-name');
  const ovBar         = document.getElementById('ov-bar');
  const ovProgress    = document.getElementById('ov-progress');
  const resultBadge   = document.getElementById('result-badge');
  const logLines      = document.getElementById('log-lines');
  const logHeader     = document.getElementById('log-header');
  const logBadge      = document.getElementById('log-badge');
  const logClearBtn   = document.getElementById('log-clear-btn');
  const cookieBtn     = document.getElementById('cookie-btn');
  const cookieModal   = document.getElementById('cookie-modal');
  const cookieTbody   = document.getElementById('cookie-tbody');
  const cookieAddRow  = document.getElementById('cookie-add-row');
  const cookieClear   = document.getElementById('cookie-clear');
  const cookieApply   = document.getElementById('cookie-apply');
  const ovCancel      = document.getElementById('ov-cancel');
  const overlay       = document.getElementById('replay-overlay');
  const ovTitle       = document.getElementById('ov-title');
  const ovSuiteInfo   = document.getElementById('ov-suite-info');
  const ovSuiteResult = document.getElementById('ov-suite-result');
  const suiteBtn      = document.getElementById('suite-btn');
  const urlTreeBtn    = document.getElementById('url-tree-btn');
  const urlTreePopup  = document.getElementById('url-tree-popup');
  const urlTreeBody   = document.getElementById('url-tree-body');
  const urlTreeCount  = document.getElementById('url-tree-count');

  // ── State ─────────────────────────────────────────────────────────────────────
  let ws            = null;
  let wsReady       = false;
  let isRecording   = false;
  let isReplaying   = false;
  let suiteMode     = false;
  let suitePass     = 0;
  let suiteFail     = 0;
  let recordings    = [];
  let currentPageUrl = '';
  let selectedId    = null;
  let checkedIds    = new Set();
  let historyMap    = {};
  let viewport      = { width: 1280, height: 720 };
  let replayingName = '';

  // ── localStorage persistence ──────────────────────────────────────────────────
  const LS_URL_KEY    = 'bat_url_history';
  const LS_COOKIE_KEY = 'bat_cookie_rows';
  const URL_HIST_MAX  = 30;

  function loadUrlHistory() {
    try { return JSON.parse(localStorage.getItem(LS_URL_KEY) || '[]'); } catch { return []; }
  }
  function saveUrlHistory(url) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    let hist = loadUrlHistory().filter(u => u !== url);
    hist.unshift(url);
    hist = hist.slice(0, URL_HIST_MAX);
    localStorage.setItem(LS_URL_KEY, JSON.stringify(hist));
    refreshUrlDatalist(hist);
  }
  function refreshUrlDatalist(hist) {
    const dl = document.getElementById('url-history');
    if (!dl) return;
    dl.innerHTML = hist.map(u => `<option value="${esc(u)}" label="${esc(u)}"></option>`).join('');
  }
  // Populate datalist from saved history on load
  refreshUrlDatalist(loadUrlHistory());

  function saveCookiesToStorage() {
    const rows = Array.from(cookieTbody.querySelectorAll('tr')).map(tr => {
      const g = f => tr.querySelector(`[data-field="${f}"]`);
      return { name: g('name').value, value: g('value').value,
               domain: g('domain').value, path: g('path').value || '/',
               secure: g('secure').checked, httpOnly: g('httpOnly').checked };
    }).filter(c => c.name && c.value);
    localStorage.setItem(LS_COOKIE_KEY, JSON.stringify(rows));
  }
  function loadCookiesFromStorage() {
    try { return JSON.parse(localStorage.getItem(LS_COOKIE_KEY) || '[]'); } catch { return []; }
  }

  // ── Status helper ─────────────────────────────────────────────────────────────
  function setStatus(msg) { statusText.textContent = msg; }

  // ── WebSocket connection ───────────────────────────────────────────────────────
  const WS_MAX_RETRIES = 10;
  const WS_BASE_DELAY  = 2000;
  let wsRetry = 0;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      wsReady  = true;
      wsRetry  = 0;
      setStatus('연결됨. URL을 입력하고 이동하세요.');
      document.getElementById('statusbar')?.classList.add('connected');
    });

    ws.addEventListener('close', () => {
      wsReady = false;
      recordBtn.disabled = true;
      document.getElementById('statusbar')?.classList.remove('connected', 'recording', 'replaying');
      if (wsRetry >= WS_MAX_RETRIES) {
        setStatus('서버에 연결할 수 없습니다. 페이지를 새로고침하세요.');
        return;
      }
      const delay = Math.min(WS_BASE_DELAY * Math.pow(2, wsRetry), 30000);
      wsRetry++;
      setStatus(`서버 연결이 끊겼습니다. ${(delay / 1000).toFixed(0)}초 후 재연결 중… (${wsRetry}/${WS_MAX_RETRIES})`);
      setTimeout(connect, delay);
    });

    ws.addEventListener('error', () => {
      setStatus('WebSocket 연결 오류가 발생했습니다. 재연결 중…');
      appendLog('warn', null, 'WebSocket 오류 발생');
    });

    ws.addEventListener('message', e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    });
  }

  function send(obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ── Server message handler ────────────────────────────────────────────────────
  function handleServerMessage(msg) {
    switch (msg.type) {

      case 'ready':
        if (msg.viewport) {
          viewport = msg.viewport;
          canvas.width  = viewport.width;
          canvas.height = viewport.height;
        }
        recordBtn.disabled = false;
        break;

      case 'frame':
        renderFrame(msg.data);
        break;

      case 'url-changed':
        frameUrlLabel.textContent = msg.url || 'about:blank';
        urlInput.value = msg.url && msg.url !== 'about:blank' ? msg.url : urlInput.value;
        currentPageUrl = msg.url || '';
        // Toggle the empty-canvas hint based on whether a real page is loaded
        const wrap = document.querySelector('.canvas-wrap');
        if (wrap) {
          const isBlank = !msg.url || msg.url === 'about:blank';
          wrap.dataset.blank = isBlank ? '1' : '';
        }
        renderList();
        break;

      case 'recording-started':
        isRecording = true;
        recordBtn.classList.add('active');
        recordBtn.innerHTML = '<span class="dot"></span> 중지';
        recBadge.classList.remove('hidden');
        replayBtn.disabled = true;
        setStatus('기록 중… 브라우저에서 자유롭게 상호작용하세요.');
        document.getElementById('statusbar')?.classList.add('recording');
        break;

      case 'recording-event':
        setStatus(`기록 중… ${msg.count}개 이벤트 캡처됨`);
        break;

      case 'recording-saved':
        isRecording = false;
        recordBtn.classList.remove('active');
        recordBtn.innerHTML = '<span class="dot"></span> 기록';
        document.getElementById('statusbar')?.classList.remove('recording');
        recBadge.classList.add('hidden');
        setStatus(`저장 완료 — ${msg.recording.name} (${msg.recording.eventCount}개 이벤트)`);
        break;

      case 'recording-empty':
        isRecording = false;
        recordBtn.classList.remove('active');
        recordBtn.innerHTML = '<span class="dot"></span> 기록';
        document.getElementById('statusbar')?.classList.remove('recording');
        recBadge.classList.add('hidden');
        setStatus('기록된 이벤트가 없습니다.');
        break;

      case 'recordings': {
        recordings = msg.list || [];
        const validIds = new Set(recordings.map(r => r.id));
        for (const id of [...checkedIds]) { if (!validIds.has(id)) checkedIds.delete(id); }
        if (recordings.length > 0 && selectedId === null) {
          selectedId = recordings[recordings.length - 1].id;
          replayBtn.disabled = false;
        }
        if (recordings.length === 0) {
          selectedId = null;
          replayBtn.disabled = true;
        }
        updateSuiteBtn();
        renderList();
        // Re-render the URL tree popup if it's currently open
        if (!urlTreePopup.classList.contains('hidden')) renderUrlTree();
        break;
      }

      case 'replay-started':
        isReplaying = true;
        if (!suiteMode) {
          replayBtn.disabled = true;
          recordBtn.disabled = true;
          showOverlay(replayingName, 0, 0);
        }
        document.getElementById('statusbar')?.classList.add('replaying');
        break;

      case 'replay-progress':
        updateOverlay(msg.done, msg.total);
        break;

      case 'replay-done':
        isReplaying = false;
        if (!suiteMode) {
          replayBtn.disabled = selectedId === null;
          recordBtn.disabled = false;
          hideOverlay();
          setStatus(`재생 완료 — ${replayingName}`);
        }
        document.getElementById('statusbar')?.classList.remove('replaying');
        break;

      case 'history-all':
        historyMap = msg.map || {};
        renderList();
        break;

      case 'history':
        if (msg.recordingId != null) {
          historyMap[msg.recordingId] = msg.runs || [];
          renderList();
        }
        break;

      case 'suite-started':
        suiteMode  = true;
        suitePass  = 0;
        suiteFail  = 0;
        ovTitle.innerHTML = `${ICON('zap')} 스위트 실행 중`;
        ovSuiteInfo.textContent = `0 / ${msg.total}`;
        ovSuiteInfo.classList.remove('hidden');
        ovSuiteResult.textContent = '';
        ovSuiteResult.classList.remove('hidden');
        overlay.classList.add('visible');
        replayBtn.disabled = true;
        recordBtn.disabled = true;
        suiteBtn.disabled  = true;
        break;

      case 'suite-item-started':
        ovName.textContent = msg.name;
        ovSuiteInfo.textContent = `${msg.index + 1} / ${msg.total}`;
        ovBar.style.width   = '0%';
        ovProgress.textContent = '준비 중…';
        break;

      case 'suite-item-done':
        if (msg.failed === 0) suitePass++;
        else suiteFail++;
        ovSuiteResult.innerHTML =
          `<span class="ov-pass">${ICON('checkCircle')} ${suitePass}</span>` +
          `<span class="ov-fail">${ICON('xCircle')} ${suiteFail}</span>`;
        break;

      case 'suite-done':
        suiteMode = false;
        overlay.classList.remove('visible');
        ovTitle.innerHTML = `${ICON('play')} 재생 중`;
        ovSuiteInfo.classList.add('hidden');
        ovSuiteResult.classList.add('hidden');
        replayBtn.disabled = selectedId === null;
        recordBtn.disabled = false;
        updateSuiteBtn();
        setStatus(`스위트 완료 — 성공 ${msg.passed} / 실패 ${msg.failed} (총 ${msg.total}개)`);
        break;

      case 'replay-result':
        showReplayResult(msg);
        break;

      case 'log':
        appendLog(msg.level, msg.ts, msg.message);
        break;

      case 'cookies-applied':
        setStatus(`쿠키 적용 완료 — ${msg.count}개`);
        break;

      case 'error':
        setStatus('오류: ' + (msg.message || '알 수 없는 오류'));
        appendLog('fail', null, '오류: ' + (msg.message || ''));
        break;
    }
  }

  // ── Canvas frame rendering ────────────────────────────────────────────────────
  const img = new Image();
  img.addEventListener('load', () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  });

  function renderFrame(base64) {
    img.src = 'data:image/jpeg;base64,' + base64;
  }

  // ── Coordinate scaling ────────────────────────────────────────────────────────
  let _cachedRect = null;
  window.addEventListener('resize', () => { _cachedRect = null; });
  function getCanvasRect() {
    if (!_cachedRect) _cachedRect = canvas.getBoundingClientRect();
    return _cachedRect;
  }

  function canvasCoords(e) {
    const rect   = getCanvasRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top)  * scaleY),
    };
  }

  function btnName(b) {
    return b === 2 ? 'right' : b === 1 ? 'middle' : 'left';
  }

  // ── Canvas input forwarding ───────────────────────────────────────────────────
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  let _mousemoveRafId = null;
  canvas.addEventListener('mousemove', e => {
    if (_mousemoveRafId !== null) return;
    _mousemoveRafId = requestAnimationFrame(() => {
      _mousemoveRafId = null;
      const { x, y } = canvasCoords(e);
      send({ type: 'mousemove', x, y });
    });
  });

  canvas.addEventListener('mousedown', e => {
    canvas.focus();
    const { x, y } = canvasCoords(e);
    send({ type: 'mousedown', x, y, button: btnName(e.button) });
  });

  canvas.addEventListener('mouseup', e => {
    const { x, y } = canvasCoords(e);
    send({ type: 'mouseup', x, y, button: btnName(e.button) });
  });

  canvas.addEventListener('click', e => {
    const { x, y } = canvasCoords(e);
    send({ type: 'click', x, y, button: btnName(e.button) });
  });

  canvas.addEventListener('dblclick', e => {
    const { x, y } = canvasCoords(e);
    send({ type: 'dblclick', x, y });
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    send({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });

  const PASSTHROUGH_KEYS = new Set(['F12', 'Escape']);
  const PASSTHROUGH_CTRL = new Set(['c', 'C', 'a', 'A', 'v', 'V', 'z', 'Z', 'x', 'X']);
  function shouldPassthrough(e) {
    if (PASSTHROUGH_KEYS.has(e.key)) return true;
    if ((e.ctrlKey || e.metaKey) && PASSTHROUGH_CTRL.has(e.key)) return true;
    return false;
  }

  canvas.addEventListener('keydown', e => {
    if (shouldPassthrough(e)) return;
    e.preventDefault();
    send({ type: 'keydown', key: e.key, code: e.code });
  });

  canvas.addEventListener('keyup', e => {
    if (shouldPassthrough(e)) return;
    e.preventDefault();
    send({ type: 'keyup', key: e.key, code: e.code });
  });

  // ── Navigation ────────────────────────────────────────────────────────────────
  function navigate(rawUrl) {
    let url = rawUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    urlInput.value = url;
    urlInput.blur();
    saveUrlHistory(url);
    setStatus(`로드 중: ${url}`);
    send({ type: 'navigate', url });
  }

  goBtn.addEventListener('click', () => navigate(urlInput.value));
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(urlInput.value); });

  // ── URL tree popup (origin → paths from existing test cases) ──────────────────
  // Track which origins are expanded so the user's choice persists across
  // re-renders triggered by 'recordings' WS events.
  const expandedOrigins = new Set();

  function originOf(url) {
    try { return new URL(url).origin; } catch { return ''; }
  }
  function pathOf(url) {
    try {
      const u = new URL(url);
      return (u.pathname || '/') + u.search + u.hash;
    } catch { return url; }
  }

  function renderUrlTree() {
    // Group recordings by origin → unique paths (count duplicates)
    const groups = new Map(); // origin → Map<path, count>
    for (const r of recordings) {
      const o = originOf(r.url);
      if (!o) continue;
      const p = pathOf(r.url);
      if (!groups.has(o)) groups.set(o, new Map());
      const paths = groups.get(o);
      paths.set(p, (paths.get(p) || 0) + 1);
    }

    const totalOrigins = groups.size;
    const totalPaths = [...groups.values()].reduce((a, m) => a + m.size, 0);
    urlTreeCount.textContent = `${totalOrigins} 도메인 · ${totalPaths} 경로`;

    if (totalOrigins === 0) {
      urlTreeBody.innerHTML = '<p class="empty-msg url-tree-empty">아직 등록된 테스트 케이스가 없습니다.</p>';
      return;
    }

    // Sort origins alphabetically; paths within each by name
    const sortedOrigins = [...groups.keys()].sort();
    const html = sortedOrigins.map(origin => {
      const paths = groups.get(origin);
      const sortedPaths = [...paths.keys()].sort();
      const expanded = expandedOrigins.has(origin);
      const pathsHtml = sortedPaths.map(p => {
        const count = paths.get(p);
        const fullUrl = origin + p;
        const countLabel = count > 1 ? `${count}건` : '';
        return `<button class="url-tree-path" data-url="${esc(fullUrl)}">
          <span class="path-text">${esc(p)}</span>
          ${countLabel ? `<span class="path-count">${countLabel}</span>` : ''}
        </button>`;
      }).join('');
      return `
        <button class="url-tree-origin ${expanded ? 'expanded' : ''}" data-origin="${esc(origin)}">
          <span class="twist">${ICON('chevronRight')}</span>
          <span class="origin-host">${esc(origin)}</span>
          <span class="origin-count">${paths.size}</span>
        </button>
        <div class="url-tree-paths ${expanded ? '' : 'hidden'}" data-origin="${esc(origin)}">
          ${pathsHtml}
        </div>
      `;
    }).join('');
    urlTreeBody.innerHTML = html;
  }

  function showUrlTree() {
    renderUrlTree();
    urlTreePopup.classList.remove('hidden');
    urlTreeBtn.classList.add('active');
  }
  function hideUrlTree() {
    urlTreePopup.classList.add('hidden');
    urlTreeBtn.classList.remove('active');
  }
  function toggleUrlTree() {
    if (urlTreePopup.classList.contains('hidden')) showUrlTree();
    else hideUrlTree();
  }

  urlTreeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUrlTree();
  });

  // Delegate clicks inside the popup. stopPropagation is critical: after
  // renderUrlTree() rebuilds the DOM, the original e.target is detached,
  // which makes the document-level "click outside" handler think the click
  // was outside the popup and close it.
  urlTreeBody.addEventListener('click', (e) => {
    e.stopPropagation();
    const originBtn = e.target.closest('.url-tree-origin');
    if (originBtn) {
      const origin = originBtn.dataset.origin;
      if (expandedOrigins.has(origin)) expandedOrigins.delete(origin);
      else expandedOrigins.add(origin);
      renderUrlTree();
      return;
    }
    const pathBtn = e.target.closest('.url-tree-path');
    if (pathBtn) {
      const url = pathBtn.dataset.url;
      hideUrlTree();
      navigate(url);
    }
  });

  // Close on outside click or Escape
  document.addEventListener('click', (e) => {
    if (urlTreePopup.classList.contains('hidden')) return;
    if (urlTreePopup.contains(e.target)) return;
    if (urlTreeBtn.contains(e.target)) return;
    hideUrlTree();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !urlTreePopup.classList.contains('hidden')) hideUrlTree();
  });

  // ── Recording controls ────────────────────────────────────────────────────────
  let _recordBtnTimeout = null;
  recordBtn.addEventListener('click', () => {
    if (_recordBtnTimeout !== null) return;
    _recordBtnTimeout = setTimeout(() => { _recordBtnTimeout = null; }, 300);
    if (isRecording) {
      send({ type: 'stop-recording' });
    } else {
      send({ type: 'start-recording' });
    }
  });

  replayBtn.addEventListener('click', () => {
    if (selectedId !== null) replayRecording(selectedId);
  });

  // ── Replay ────────────────────────────────────────────────────────────────────
  function replayRecording(id) {
    const meta = recordings.find(r => r.id === id);
    if (!meta) return;
    replayingName = meta.name;
    setStatus(`재생 시작: ${meta.name}`);
    send({ type: 'replay', id, speedFactor: parseFloat(speedSelect.value),
           compareHttp: httpCompareChk.checked,
           mockReplay: mockReplayChk.checked });
  }

  // ── Replay overlay ────────────────────────────────────────────────────────────
  function showOverlay(name, done, total) {
    ovName.textContent    = name;
    updateOverlay(done, total);
    overlay.classList.add('visible');
  }

  function updateOverlay(done, total) {
    const raw = total > 0 ? Math.round((done / total) * 100) : 0;
    const pct = Math.min(100, Math.max(0, raw));
    ovBar.style.width       = `${pct}%`;
    ovProgress.textContent  = total > 0
      ? `${done} / ${total} 이벤트 (${pct}%)`
      : '준비 중…';
  }

  function hideOverlay() {
    overlay.classList.remove('visible');
  }

  ovCancel.addEventListener('click', () => {
    send({ type: 'cancel-replay' });
    hideOverlay();
    isReplaying = false;
    suiteMode   = false;
    replayBtn.disabled  = selectedId === null;
    recordBtn.disabled  = false;
    setStatus('재생 취소됨.');
  });

  // ── Export ────────────────────────────────────────────────────────────────────
  async function exportJson(id) {
    try {
      const res = await fetch(`/api/recordings/${id}`);
      const rec = await res.json();
      const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
      triggerDownload(blob, `${safeName(rec.name)}.json`);
      setStatus(`JSON 내보내기 완료 — ${rec.name}`);
    } catch (err) {
      setStatus('JSON 내보내기 실패: ' + err.message);
    }
  }

  function exportScript(id) {
    const meta = recordings.find(r => r.id === id);
    const a = document.createElement('a');
    a.href = `/api/recordings/${id}/export/puppeteer`;
    a.download = `${safeName(meta?.name)}.js`;
    a.click();
    setStatus(`Puppeteer 스크립트 내보내기 — ${meta?.name}`);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeName(name) {
    return (name || 'recording').replace(/[^\w\s-]/g, '_');
  }

  // ── Delete ────────────────────────────────────────────────────────────────────
  function deleteRecording(id) {
    send({ type: 'delete-recording', id });
    setStatus('테스트 케이스 삭제됨.');
  }

  // ── Suite button ──────────────────────────────────────────────────────────────
  function updateSuiteBtn() {
    const busy = isReplaying || suiteMode;
    const empty = recordings.length === 0;
    suiteBtn.disabled = empty || busy;
    suiteBtn.innerHTML = checkedIds.size > 0
      ? `${ICON('zap')} 스위트 (${checkedIds.size})`
      : `${ICON('zap')} 스위트`;
    suiteBtn.title = empty  ? '테스트 케이스가 없습니다'
      : suiteMode           ? '스위트 실행 중'
      : isReplaying         ? '재생 중 — 완료 후 사용 가능'
      : checkedIds.size > 0 ? `선택된 ${checkedIds.size}개 테스트 케이스를 순서대로 실행`
      :                       '모든 테스트 케이스를 순서대로 일괄 실행';
  }

  suiteBtn.addEventListener('click', () => {
    if (recordings.length === 0) return;
    const ids = checkedIds.size > 0
      ? [...checkedIds]
      : recordings.map(r => r.id);
    send({ type: 'run-suite', ids, speedFactor: parseFloat(speedSelect.value),
           compareHttp: httpCompareChk.checked,
           mockReplay: mockReplayChk.checked });
  });

  // ── Render recording list ─────────────────────────────────────────────────────
  function renderTagChips(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return '';
    return `<div class="rec-tags">${tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('')}</div>`;
  }

  function renderHistoryDots(recId) {
    const runs = historyMap[recId];
    if (!Array.isArray(runs) || runs.length === 0) return '';
    const dots = runs.slice(0, 8).reverse().map(r => {
      const cls  = r.total === 0 ? 'skip'
                 : r.failed === 0 ? 'pass'
                 : r.passed === 0 ? 'fail' : 'partial';
      const time = r.runAt ? new Date(r.runAt).toLocaleString('ko-KR') : '';
      const tip  = `${time} | 성공 ${r.passed}/${r.total}${r.durationMs ? '  (' + Math.round(r.durationMs / 1000) + 's)' : ''}`;
      return `<span class="history-dot ${cls}" title="${esc(tip)}"></span>`;
    }).join('');
    return `<div class="history-dots">${dots}</div>`;
  }

  // Page-key for filtering: same origin + pathname counts as same page,
  // ignoring query string and hash so /orders?status=A and /orders?status=B
  // both belong to the /orders page.
  function pageKey(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return '';
    }
  }

  // Path-only key: pathname without origin — used as fallback to find
  // recordings made on a different environment (local ↔ staging ↔ prod).
  function pathKey(url) {
    if (!url) return '';
    try { return new URL(url).pathname; } catch { return ''; }
  }

  function renderList() {
    const curKey  = pageKey(currentPageUrl);
    const curPath = pathKey(currentPageUrl);

    // 1차: origin + pathname 완전 일치
    let visible   = curKey ? recordings.filter(r => pageKey(r.url) === curKey) : [];
    let crossEnv  = false;

    // 2차: origin이 다른 경우 pathname만으로 폴백 (다른 환경 레코딩)
    // pathname이 일치하는 레코딩이 여러 origin에 걸쳐 있으면
    // 가장 최근(id 최대) 레코딩의 origin만 선택해서 표시
    if (visible.length === 0 && curPath) {
      const pathMatches = recordings.filter(r => pathKey(r.url) === curPath);
      if (pathMatches.length > 0) {
        const latestOrigin = (() => {
          try { return new URL(pathMatches[pathMatches.length - 1].url).origin; } catch { return null; }
        })();
        visible  = latestOrigin
          ? pathMatches.filter(r => { try { return new URL(r.url).origin === latestOrigin; } catch { return false; } })
          : pathMatches;
        crossEnv = true;
      }
    }

    recCount.textContent = crossEnv
      ? `${visible.length}개 (다른 환경)`
      : `${visible.length}개`;

    if (recordings.length === 0) {
      recList.innerHTML = '<p class="empty-msg">아직 테스트 케이스가 없습니다.</p>';
      return;
    }
    if (visible.length === 0) {
      recList.innerHTML = '<p class="empty-msg">현재 페이지에 해당하는 테스트 케이스가 없습니다.</p>';
      return;
    }

    recList.innerHTML = visible
      .slice().reverse()
      .map(rec => {
        const isSel    = rec.id === selectedId;
        const isChecked = checkedIds.has(rec.id);
        const tags  = Array.isArray(rec.tags) ? rec.tags : [];
        const desc  = rec.description || '';
        return `
<div class="rec-item${isSel ? ' selected' : ''}" data-id="${rec.id}">
  <div class="rec-item-head">
    <div style="display:flex;gap:6px;align-items:center">
      <input type="checkbox" class="rec-check" data-id="${rec.id}" ${isChecked ? 'checked' : ''} title="스위트에 포함" />
      <span class="rec-num">#${rec.id}</span>
    </div>
    <div style="display:flex;gap:4px;align-items:center">
      <button class="rec-edit" data-id="${rec.id}" title="이름/설명/태그 편집" aria-label="편집">${ICON('edit')}</button>
      <button class="rec-del"  data-id="${rec.id}" title="삭제" aria-label="삭제">${ICON('trash')}</button>
    </div>
  </div>
  <div class="rec-name" data-id="${rec.id}">${esc(rec.name)}</div>
  ${desc ? `<div class="rec-desc">${esc(desc)}</div>` : ''}
  ${renderTagChips(tags)}
  ${renderHistoryDots(rec.id)}
  <span class="rec-url" title="${esc(rec.url)}">${esc(trimUrl(rec.url))}</span>
  <div class="rec-meta">
    <span>${rec.eventCount}개 이벤트</span>
    <span>${fmtTime(rec.createdAt)}</span>
  </div>
  <div class="rec-actions">
    <button class="btn-rec-replay" data-id="${rec.id}">${ICON('play')} 재생</button>
  </div>
  <div class="rec-export">
    <button class="btn-rec-http"   data-id="${rec.id}" title="HTTP 응답 열람/편집">${ICON('server')} HTTP</button>
    <button class="btn-rec-json"   data-id="${rec.id}" title="JSON으로 내보내기">${ICON('braces')} JSON</button>
    <button class="btn-rec-script" data-id="${rec.id}" title="Puppeteer 스크립트로 내보내기">${ICON('code')} Script</button>
  </div>
  <div class="rec-edit-form hidden" data-id="${rec.id}">
    <input  class="edit-name-input"  type="text"     value="${esc(rec.name)}"  placeholder="이름" />
    <textarea class="edit-desc-input" rows="2"        placeholder="설명 (선택)">${esc(desc)}</textarea>
    <div class="edit-tags-wrap">
      ${tags.map(t => `<span class="tag-chip editable" data-tag="${esc(t)}">${esc(t)}<button class="tag-rm" data-tag="${esc(t)}">×</button></span>`).join('')}
      <input class="edit-tag-input" type="text" placeholder="태그 입력 후 Enter" />
    </div>
    <div class="edit-form-btns">
      <button class="btn-edit-cancel" data-id="${rec.id}">취소</button>
      <button class="btn-edit-save"   data-id="${rec.id}">저장</button>
    </div>
  </div>
</div>`;
      })
      .join('');
  }

  // ── Inline edit helpers ───────────────────────────────────────────────────────
  function openEditForm(id) {
    const item = recList.querySelector(`.rec-item[data-id="${id}"]`);
    if (!item) return;
    item.querySelector('.rec-edit-form').classList.remove('hidden');

    // Tag-input: add chip on Enter
    const tagInput = item.querySelector('.edit-tag-input');
    tagInput.addEventListener('keydown', function handler(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const val = tagInput.value.trim();
      if (!val) return;
      tagInput.value = '';
      const wrap = item.querySelector('.edit-tags-wrap');
      const chip = document.createElement('span');
      chip.className = 'tag-chip editable';
      chip.dataset.tag = val;
      chip.innerHTML = `${esc(val)}<button class="tag-rm" data-tag="${esc(val)}">×</button>`;
      wrap.insertBefore(chip, tagInput);
    });
  }

  function saveEditForm(id) {
    const item = recList.querySelector(`.rec-item[data-id="${id}"]`);
    if (!item) return;
    const name  = item.querySelector('.edit-name-input').value.trim();
    const desc  = item.querySelector('.edit-desc-input').value.trim();
    const tags  = Array.from(item.querySelectorAll('.tag-chip.editable[data-tag]'))
                    .map(c => c.dataset.tag).filter(Boolean);
    send({ type: 'update-recording', id, name, description: desc, tags });
  }

  recList.addEventListener('click', e => {
    const check   = e.target.closest('.rec-check');
    const del     = e.target.closest('.rec-del');
    const edit    = e.target.closest('.rec-edit');
    const cancel  = e.target.closest('.btn-edit-cancel');
    const save    = e.target.closest('.btn-edit-save');
    const tagRm   = e.target.closest('.tag-rm');
    const rep     = e.target.closest('.btn-rec-replay');
    const xhttp   = e.target.closest('.btn-rec-http');
    const xjson   = e.target.closest('.btn-rec-json');
    const xscript = e.target.closest('.btn-rec-script');
    const item    = e.target.closest('.rec-item');

    if (check)   {
      e.stopPropagation();
      const id = +check.dataset.id;
      if (check.checked) checkedIds.add(id);
      else checkedIds.delete(id);
      updateSuiteBtn();
      return;
    }
    if (del)     { e.stopPropagation(); deleteRecording(+del.dataset.id);   return; }
    if (edit)    { e.stopPropagation(); openEditForm(+edit.dataset.id);     return; }
    if (cancel)  { e.stopPropagation(); renderList();                        return; }
    if (save)    { e.stopPropagation(); saveEditForm(+save.dataset.id);     return; }
    if (tagRm)   { e.stopPropagation(); tagRm.closest('.tag-chip').remove(); return; }
    if (rep)     { e.stopPropagation(); replayRecording(+rep.dataset.id);   return; }
    if (xhttp)   { e.stopPropagation(); openRespModal(+xhttp.dataset.id);   return; }
    if (xjson)   { e.stopPropagation(); exportJson(+xjson.dataset.id);      return; }
    if (xscript) { e.stopPropagation(); exportScript(+xscript.dataset.id);  return; }
    if (item && !e.target.closest('.rec-edit-form')) {
      selectedId = +item.dataset.id;
      replayBtn.disabled = isReplaying || suiteMode;
      renderList();
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function trimUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname + (u.pathname === '/' ? '' : u.pathname);
    } catch { return url; }
  }

  function fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString('ko-KR'); }
    catch { return ''; }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Log panel ─────────────────────────────────────────────────────────────────
  const MAX_LOG_LINES = 500;
  let lastLogLevel = 'info';

  function appendLog(level, ts, message) {
    lastLogLevel = level;

    const line = document.createElement('div');
    line.className = `log-line ${level}`;
    line.innerHTML =
      `<span class="log-ts">${esc(ts ?? new Date().toLocaleTimeString('ko-KR', { hour12: false }))}</span>` +
      `<span class="log-msg">${esc(message)}</span>`;

    logLines.appendChild(line);

    // Trim old lines — insert a sentinel when trimming begins
    if (logLines.childElementCount >= MAX_LOG_LINES) {
      while (logLines.childElementCount >= MAX_LOG_LINES)
        logLines.removeChild(logLines.firstChild);
      const sentinel = document.createElement('div');
      sentinel.className = 'log-line warn log-trim-notice';
      sentinel.innerHTML =
        '<span class="log-ts">—</span>' +
        '<span class="log-msg">이전 로그 500줄 잘림</span>';
      logLines.insertBefore(sentinel, logLines.firstChild);
    }

    // Auto-scroll if not manually scrolled up
    const body = logLines.parentElement;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 40)
      body.scrollTop = body.scrollHeight;
  }

  function updateLogBadge(level) {
    logBadge.className = `log-badge ${level}`;
    const labels = { success: 'SUCCESS', fail: 'FAIL', warn: 'PARTIAL' };
    logBadge.textContent = labels[level] ?? '';
  }

  // Toggle collapse
  logHeader.addEventListener('click', e => {
    if (e.target === logClearBtn) return;
    document.body.classList.toggle('log-collapsed');
  });

  logClearBtn.addEventListener('click', e => {
    e.stopPropagation();
    logLines.innerHTML = '';
    logBadge.className = 'log-badge';
    logBadge.textContent = '';
  });

  // ── Replay result badge ───────────────────────────────────────────────────────
  function showReplayResult({ results, toastResults, triggerResults, jsErrors, passed, failed, total }) {
    resultBadge.className = 'result-badge';

    const jsFail      = (jsErrors       || []).length;
    const triggerFail = (triggerResults || []).filter(r => !r.pass).length;
    const totalFail   = failed;  // already includes all failure types from server

    if (total === 0 && jsFail === 0) {
      resultBadge.classList.add('hidden');
      return;
    }

    let cls, iconSvg, text;
    const extras = [];
    if (totalFail === 0 && jsFail === 0) {
      cls  = 'pass';
      iconSvg = ICON('checkCircle');
      text = `SUCCESS  ${passed}/${total}`;
      if (toastResults && toastResults.length) extras.push(`${ICON('bell')} ${toastResults.length}`);
      if (triggerResults && triggerResults.length) extras.push(`${ICON('link')} ${triggerResults.length}`);
    } else if (passed === 0 && totalFail > 0) {
      cls  = 'fail';
      iconSvg = ICON('xCircle');
      text = `FAIL  ${totalFail}건 실패`;
      if (jsFail)      extras.push(`JS×${jsFail}`);
      if (triggerFail) extras.push(`${ICON('link')}×${triggerFail}`);
    } else {
      cls  = 'mixed';
      iconSvg = ICON('xCircle');
      text = `PARTIAL  ${passed} 성공 / ${totalFail} 실패`;
    }

    resultBadge.classList.add(cls);
    const extrasHtml = extras.length ? `  <span class="rb-extras">${extras.join('  ')}</span>` : '';
    resultBadge.innerHTML = `<span class="rb-icon">${iconSvg}</span><span>${text}</span>${extrasHtml}`;

    updateLogBadge(cls);

    // Auto-hide after 15s
    clearTimeout(resultBadge._timer);
    resultBadge._timer = setTimeout(() => resultBadge.classList.add('hidden'), 15000);
  }

  // ── Cookie popup ──────────────────────────────────────────────────────────────
  function makeCookieRow(name = '', value = '', domain = '', path = '/', secure = false, httpOnly = false) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="cookie-input" data-field="name"     value="${esc(name)}"     placeholder="session_id" /></td>
      <td><input class="cookie-input" data-field="value"    value="${esc(value)}"    placeholder="abc123" /></td>
      <td><input class="cookie-input" data-field="domain"   value="${esc(domain)}"   placeholder="(현재 도메인)" /></td>
      <td><input class="cookie-input" data-field="path"     value="${esc(path)}"     placeholder="/" style="width:60px" /></td>
      <td style="text-align:center"><input type="checkbox" class="cookie-check" data-field="secure"   ${secure   ? 'checked' : ''} /></td>
      <td style="text-align:center"><input type="checkbox" class="cookie-check" data-field="httpOnly" ${httpOnly ? 'checked' : ''} /></td>
      <td><button class="cookie-row-del" title="삭제" aria-label="삭제">${ICON('x')}</button></td>`;
    tr.querySelector('.cookie-row-del').addEventListener('click', () => tr.remove());
    return tr;
  }

  function readCookieRows() {
    return Array.from(cookieTbody.querySelectorAll('tr')).map(tr => {
      const g = f => tr.querySelector(`[data-field="${f}"]`);
      const domain = g('domain').value.trim();
      const obj = {
        name:     g('name').value.trim(),
        value:    g('value').value.trim(),
        path:     g('path').value.trim() || '/',
        secure:   g('secure').checked,
        httpOnly: g('httpOnly').checked,
      };
      if (domain) obj.domain = domain;
      return obj;
    }).filter(c => c.name && c.value);
  }

  cookieBtn.addEventListener('click', () => {
    // Restore previously saved cookies when table is empty
    if (cookieTbody.children.length === 0) {
      loadCookiesFromStorage().forEach(c =>
        cookieTbody.appendChild(makeCookieRow(c.name, c.value, c.domain || '', c.path || '/', c.secure, c.httpOnly))
      );
      if (cookieTbody.children.length > 0)
        cookieBtn.classList.add('has-cookies');
    }
    cookieModal.classList.remove('hidden');
  });
  document.getElementById('cookie-modal-close').addEventListener('click', () => {
    cookieModal.classList.add('hidden');
  });
  cookieModal.addEventListener('click', e => {
    if (e.target === cookieModal) cookieModal.classList.add('hidden');
  });
  cookieAddRow.addEventListener('click', () => {
    cookieTbody.appendChild(makeCookieRow());
  });
  cookieClear.addEventListener('click', () => {
    cookieTbody.innerHTML = '';
    cookieBtn.classList.remove('has-cookies');
    localStorage.removeItem(LS_COOKIE_KEY);
  });
  cookieApply.addEventListener('click', () => {
    const cookies = readCookieRows();
    saveCookiesToStorage();
    send({ type: 'set-cookies', cookies });
    cookieBtn.classList.toggle('has-cookies', cookies.length > 0);
    cookieModal.classList.add('hidden');
    setStatus(cookies.length > 0
      ? `쿠키 ${cookies.length}개 적용 요청 중…`
      : '쿠키가 없습니다.');
  });

  // ── HTTP 응답 모달 ────────────────────────────────────────────────────────────
  const respModal       = document.getElementById('resp-modal');
  const respModalTitle  = document.getElementById('resp-modal-title');
  const respList        = document.getElementById('resp-list');
  const respCountLabel  = document.getElementById('resp-count-label');
  const respAddBtn      = document.getElementById('resp-add-btn');
  const respSaveBtn     = document.getElementById('resp-save-btn');

  let respModalId = null;   // recording id currently open in modal
  let respItems   = [];     // current responses being edited

  function openRespModal(id) {
    const meta = recordings.find(r => r.id === id);
    respModalId = id;
    respModalTitle.textContent = `HTTP 응답 — ${meta ? meta.name : '#' + id}`;
    respItems = [];
    respList.innerHTML = '<p class="empty-msg" style="padding:12px">불러오는 중…</p>';
    respModal.classList.remove('hidden');
    fetch(`/api/recordings/${id}/responses`)
      .then(r => r.json())
      .then(data => {
        respItems = Array.isArray(data) ? data.map(r => Object.assign({}, r)) : [];
        renderRespList();
      })
      .catch(() => {
        respList.innerHTML = '<p class="empty-msg" style="padding:12px;color:var(--rec-color)">불러오기 실패</p>';
      });
  }

  // Tracks which response rows are currently expanded so the user's choice
  // persists across re-renders (delete, add, edit).
  const expandedRespIdx = new Set();

  // Map a status code to a CSS class for the colored pill in the header.
  function statusClassOf(s) {
    if (s == null || s === '-' ) return 'unknown';
    const n = +s;
    if (n >= 200 && n < 300) return 'ok';
    if (n >= 300 && n < 400) return 'redir';
    if (n >= 400 && n < 500) return 'warn';
    if (n >= 500)            return 'err';
    return 'unknown';
  }

  function renderRespList() {
    respCountLabel.textContent = `${respItems.length}개 항목`;
    if (respItems.length === 0) {
      respList.innerHTML = '<p class="empty-msg" style="padding:12px">기록된 HTTP 응답이 없습니다.</p>';
      return;
    }
    respList.innerHTML = '';
    respItems.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'resp-row';
      row.dataset.idx = idx;

      const isExpanded = expandedRespIdx.has(idx);
      if (isExpanded) row.classList.add('expanded');

      const method = (item.method || 'GET').toUpperCase();
      const status = item.status;
      const statusLabel = status == null ? '—' : String(status);
      const sCls = statusClassOf(status);

      const bodyText = item.body ?? '';
      let bodyDisplay = '';
      try {
        bodyDisplay = JSON.stringify(JSON.parse(bodyText), null, 2);
      } catch {
        bodyDisplay = bodyText;
      }

      const reqBodyText = item.reqBody ?? '';
      let reqBodyDisplay = '';
      try {
        reqBodyDisplay = JSON.stringify(JSON.parse(reqBodyText), null, 2);
      } catch {
        reqBodyDisplay = reqBodyText;
      }
      const hasReqBody = reqBodyText && reqBodyText.trim() !== '';

      row.innerHTML = `
        <button type="button" class="resp-row-head" data-idx="${idx}" aria-expanded="${isExpanded ? 'true' : 'false'}">
          <span class="resp-twist">${ICON(isExpanded ? 'chevronDown' : 'chevronRight')}</span>
          <span class="resp-method method-${method.toLowerCase()}">${esc(method)}</span>
          <span class="resp-status-pill ${sCls}">${esc(statusLabel)}</span>
          <span class="resp-url-text" title="${esc(item.url || '')}">${esc(item.url || '(URL 없음)')}</span>
          <span class="resp-row-del-wrap">
            <button class="resp-row-del" data-idx="${idx}" title="항목 삭제" aria-label="항목 삭제">${ICON('trash')}</button>
          </span>
        </button>
        <div class="resp-row-detail ${isExpanded ? '' : 'hidden'}">
          <div class="resp-detail-grid">
            <label class="resp-label">URL</label>
            <input class="resp-url-input resp-input" type="text" value="${esc(item.url || '')}" data-idx="${idx}" placeholder="URL" />

            <label class="resp-label">상태 코드</label>
            <input class="resp-status-input resp-input" type="number" min="100" max="599"
              value="${esc(String(item.status ?? 200))}" data-idx="${idx}" />

            <label class="resp-label">Content-Type</label>
            <input class="resp-ct-input resp-input" type="text"
              value="${esc(item.contentType || '')}" data-idx="${idx}" placeholder="application/json" readonly />
          </div>
          ${hasReqBody ? `
          <div class="resp-body-wrap">
            <label class="resp-label">요청 바디</label>
            <textarea class="resp-reqbody-input" rows="4" data-idx="${idx}" readonly>${esc(reqBodyDisplay)}</textarea>
          </div>` : ''}
          <div class="resp-body-wrap">
            <label class="resp-label">응답 바디</label>
            <textarea class="resp-body-input" rows="8" data-idx="${idx}" placeholder="(없음)">${esc(bodyDisplay)}</textarea>
          </div>
        </div>`;
      respList.appendChild(row);
    });
  }

  respList.addEventListener('input', e => {
    const statusIn = e.target.closest('.resp-status-input');
    const urlIn    = e.target.closest('.resp-url-input');
    const bodyIn   = e.target.closest('.resp-body-input');
    if (statusIn) {
      const idx = +statusIn.dataset.idx;
      respItems[idx].status = +statusIn.value;
      // Update the status pill in the collapsed header live, no full re-render
      const pill = respList.querySelector(`.resp-row[data-idx="${idx}"] .resp-status-pill`);
      if (pill) {
        pill.textContent = statusIn.value || '—';
        pill.className = `resp-status-pill ${statusClassOf(statusIn.value)}`;
      }
      return;
    }
    if (urlIn) {
      const idx = +urlIn.dataset.idx;
      respItems[idx].url = urlIn.value;
      const span = respList.querySelector(`.resp-row[data-idx="${idx}"] .resp-url-text`);
      if (span) {
        span.textContent = urlIn.value || '(URL 없음)';
        span.title = urlIn.value;
      }
      return;
    }
    if (bodyIn)   { respItems[+bodyIn.dataset.idx].body  = bodyIn.value; return; }
  });

  respList.addEventListener('click', e => {
    // Delete button (don't bubble to row-head expand)
    const del = e.target.closest('.resp-row-del');
    if (del) {
      e.stopPropagation();
      const idx = +del.dataset.idx;
      respItems.splice(idx, 1);
      // Reset expansion (indices shifted) — keep it simple by clearing
      expandedRespIdx.clear();
      renderRespList();
      return;
    }
    // Header click toggles expansion
    const head = e.target.closest('.resp-row-head');
    if (head) {
      const idx = +head.dataset.idx;
      if (expandedRespIdx.has(idx)) expandedRespIdx.delete(idx);
      else expandedRespIdx.add(idx);
      renderRespList();
    }
  });

  respAddBtn.addEventListener('click', () => {
    respItems.push({ url: '', status: 200, contentType: 'application/json', body: '' });
    renderRespList();
    // Scroll to bottom
    respList.scrollTop = respList.scrollHeight;
  });

  respSaveBtn.addEventListener('click', async () => {
    if (respModalId === null) return;
    // Normalize body: try to compact JSON, fall back to raw string
    const toSave = respItems.map(item => {
      let body = item.body ?? null;
      if (body !== null && body.trim() === '') body = null;
      if (body !== null) {
        try { body = JSON.stringify(JSON.parse(body)); } catch {}
      }
      return { ...item, body };
    });
    try {
      const res = await fetch(`/api/recordings/${respModalId}/responses`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(toSave),
      });
      if (!res.ok) throw new Error(await res.text());
      setStatus(`HTTP 응답 저장 완료 — ${toSave.length}개`);
      respModal.classList.add('hidden');
    } catch (err) {
      setStatus('저장 실패: ' + err.message);
    }
  });

  document.getElementById('resp-modal-close').addEventListener('click', () => {
    respModal.classList.add('hidden');
  });
  respModal.addEventListener('click', e => {
    if (e.target === respModal) respModal.classList.add('hidden');
  });

  // ── Boot ──────────────────────────────────────────────────────────────────────
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  connect();

})();
