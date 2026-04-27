/* Browser Automation Tool — WebSocket + Canvas Frontend */
(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────────────────
  const urlInput      = document.getElementById('url-input');
  const goBtn         = document.getElementById('go-btn');
  const recordBtn     = document.getElementById('record-btn');
  const replayBtn     = document.getElementById('replay-btn');
  const speedSelect   = document.getElementById('speed-select');
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

  // ── State ─────────────────────────────────────────────────────────────────────
  let ws            = null;
  let wsReady       = false;
  let isRecording   = false;
  let isReplaying   = false;
  let recordings    = [];
  let selectedId    = null;
  let viewport      = { width: 1280, height: 720 };
  let replayingName = '';

  // ── Status helper ─────────────────────────────────────────────────────────────
  function setStatus(msg) { statusText.textContent = msg; }

  // ── WebSocket connection ───────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      wsReady = true;
      setStatus('연결됨. URL을 입력하고 이동하세요.');
    });

    ws.addEventListener('close', () => {
      wsReady = false;
      recordBtn.disabled = true;
      setStatus('서버 연결이 끊겼습니다. 재연결 중…');
      setTimeout(connect, 2000);
    });

    ws.addEventListener('error', () => {});

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
        break;

      case 'recording-started':
        isRecording = true;
        recordBtn.classList.add('active');
        recordBtn.innerHTML = '<span class="dot"></span> 중지';
        recBadge.classList.remove('hidden');
        replayBtn.disabled = true;
        setStatus('녹화 중… 브라우저에서 자유롭게 상호작용하세요.');
        break;

      case 'recording-event':
        setStatus(`녹화 중… ${msg.count}개 이벤트 캡처됨`);
        break;

      case 'recording-saved':
        isRecording = false;
        recordBtn.classList.remove('active');
        recordBtn.innerHTML = '<span class="dot"></span> 녹화';
        recBadge.classList.add('hidden');
        setStatus(`저장 완료 — ${msg.recording.name} (${msg.recording.eventCount}개 이벤트)`);
        break;

      case 'recording-empty':
        isRecording = false;
        recordBtn.classList.remove('active');
        recordBtn.innerHTML = '<span class="dot"></span> 녹화';
        recBadge.classList.add('hidden');
        setStatus('녹화된 이벤트가 없습니다.');
        break;

      case 'recordings':
        recordings = msg.list || [];
        if (recordings.length > 0 && selectedId === null) {
          selectedId = recordings[recordings.length - 1].id;
          replayBtn.disabled = false;
        }
        if (recordings.length === 0) {
          selectedId = null;
          replayBtn.disabled = true;
        }
        renderList();
        break;

      case 'replay-started':
        isReplaying = true;
        replayBtn.disabled = true;
        recordBtn.disabled = true;
        showOverlay(replayingName, 0, 0);
        break;

      case 'replay-progress':
        updateOverlay(msg.done, msg.total);
        break;

      case 'replay-done':
        isReplaying = false;
        replayBtn.disabled = selectedId === null;
        recordBtn.disabled = false;
        hideOverlay();
        setStatus(`재생 완료 — ${replayingName}`);
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
  function canvasCoords(e) {
    const rect  = canvas.getBoundingClientRect();
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

  canvas.addEventListener('mousemove', e => {
    const { x, y } = canvasCoords(e);
    send({ type: 'mousemove', x, y });
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

  canvas.addEventListener('keydown', e => {
    e.preventDefault();
    send({ type: 'keydown', key: e.key, code: e.code });
  });

  canvas.addEventListener('keyup', e => {
    e.preventDefault();
    send({ type: 'keyup', key: e.key, code: e.code });
  });

  // ── Navigation ────────────────────────────────────────────────────────────────
  function navigate(rawUrl) {
    let url = rawUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    urlInput.value = url;
    setStatus(`로드 중: ${url}`);
    send({ type: 'navigate', url });
  }

  goBtn.addEventListener('click', () => navigate(urlInput.value));
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(urlInput.value); });

  // ── Recording controls ────────────────────────────────────────────────────────
  recordBtn.addEventListener('click', () => {
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
    send({ type: 'replay', id, speedFactor: parseFloat(speedSelect.value) });
  }

  // ── Replay overlay ────────────────────────────────────────────────────────────
  function showOverlay(name, done, total) {
    ovName.textContent    = name;
    updateOverlay(done, total);
    overlay.classList.add('visible');
  }

  function updateOverlay(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    ovBar.style.width       = `${pct}%`;
    ovProgress.textContent  = total > 0
      ? `${done} / ${total} 이벤트 (${pct}%)`
      : '준비 중…';
  }

  function hideOverlay() {
    overlay.classList.remove('visible');
  }

  ovCancel.addEventListener('click', () => {
    hideOverlay();
    isReplaying = false;
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
    setStatus('녹화 삭제됨.');
  }

  // ── Render recording list ─────────────────────────────────────────────────────
  function renderList() {
    recCount.textContent = `${recordings.length}개`;

    if (recordings.length === 0) {
      recList.innerHTML = '<p class="empty-msg">아직 녹화가 없습니다.</p>';
      return;
    }

    recList.innerHTML = recordings
      .slice()
      .reverse()
      .map(rec => {
        const isSel = rec.id === selectedId;
        return `
<div class="rec-item${isSel ? ' selected' : ''}" data-id="${rec.id}">
  <div class="rec-item-head">
    <span class="rec-num">#${rec.id}</span>
    <button class="rec-del" data-id="${rec.id}" title="삭제">✕</button>
  </div>
  <span class="rec-url" title="${esc(rec.url)}">${esc(trimUrl(rec.url))}</span>
  <div class="rec-meta">
    <span>${rec.eventCount}개 이벤트</span>
    <span>${fmtTime(rec.createdAt)}</span>
  </div>
  <div class="rec-actions">
    <button class="btn-rec-replay" data-id="${rec.id}">▶ 재생</button>
  </div>
  <div class="rec-export">
    <button class="btn-rec-json"   data-id="${rec.id}" title="JSON으로 내보내기">📥 JSON</button>
    <button class="btn-rec-script" data-id="${rec.id}" title="Puppeteer 스크립트로 내보내기">📜 Script</button>
  </div>
</div>`;
      })
      .join('');
  }

  recList.addEventListener('click', e => {
    const del     = e.target.closest('.rec-del');
    const rep     = e.target.closest('.btn-rec-replay');
    const xjson   = e.target.closest('.btn-rec-json');
    const xscript = e.target.closest('.btn-rec-script');
    const item    = e.target.closest('.rec-item');

    if (del)     { e.stopPropagation(); deleteRecording(+del.dataset.id);   return; }
    if (rep)     { e.stopPropagation(); replayRecording(+rep.dataset.id);   return; }
    if (xjson)   { e.stopPropagation(); exportJson(+xjson.dataset.id);      return; }
    if (xscript) { e.stopPropagation(); exportScript(+xscript.dataset.id);  return; }
    if (item) {
      selectedId = +item.dataset.id;
      replayBtn.disabled = false;
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

    // Trim old lines
    while (logLines.childElementCount > MAX_LOG_LINES)
      logLines.removeChild(logLines.firstChild);

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
  function showReplayResult({ results, passed, failed, total }) {
    resultBadge.className = 'result-badge';

    if (total === 0) {
      resultBadge.classList.add('hidden');
      return;
    }

    let cls, icon, text;
    if (failed === 0) {
      cls  = 'pass';
      icon = '✅';
      text = `SUCCESS  ${passed}/${total} 응답 일치`;
    } else if (passed === 0) {
      cls  = 'fail';
      icon = '❌';
      text = `FAIL  ${failed}/${total} 응답 불일치`;
    } else {
      cls  = 'mixed';
      icon = '⚠️';
      text = `PARTIAL  ${passed} 성공 / ${failed} 실패`;
    }

    resultBadge.classList.add(cls);
    resultBadge.innerHTML = `<span class="rb-icon">${icon}</span><span>${text}</span>`;

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
      <td><button class="cookie-row-del" title="삭제">✕</button></td>`;
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
  });
  cookieApply.addEventListener('click', () => {
    const cookies = readCookieRows();
    send({ type: 'set-cookies', cookies });
    cookieBtn.classList.toggle('has-cookies', cookies.length > 0);
    cookieModal.classList.add('hidden');
    setStatus(cookies.length > 0
      ? `쿠키 ${cookies.length}개 적용 요청 중…`
      : '쿠키가 없습니다.');
  });

  // ── Boot ──────────────────────────────────────────────────────────────────────
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  connect();

})();
