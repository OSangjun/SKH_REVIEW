/* Browser Automation Tool — Frontend Controller */
(function () {
  'use strict';

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const urlInput      = document.getElementById('url-input');
  const goBtn         = document.getElementById('go-btn');
  const recordBtn     = document.getElementById('record-btn');
  const headerReplay  = document.getElementById('replay-btn');
  const frame         = document.getElementById('browser-frame');
  const frameUrlLabel = document.getElementById('frame-url');
  const recBadge      = document.getElementById('rec-badge');
  const statusText    = document.getElementById('status-text');
  const recList       = document.getElementById('rec-list');
  const recCount      = document.getElementById('rec-count');

  // ── State ───────────────────────────────────────────────────────────────────
  let isRecording        = false;
  let capturedEvents     = [];
  let currentProxyUrl    = '';   // /proxy?url=... loaded in iframe
  let currentRealUrl     = '';   // actual target URL
  let selectedId         = null;
  let recordings         = [];   // [{id,name,url,eventCount,createdAt}, ...]

  // ── Status helper ───────────────────────────────────────────────────────────
  function setStatus(msg) { statusText.textContent = msg; }

  // ── Navigation ──────────────────────────────────────────────────────────────
  function navigate(rawUrl) {
    let url = rawUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    currentRealUrl   = url;
    currentProxyUrl  = `/proxy?url=${encodeURIComponent(url)}`;
    urlInput.value   = url;
    frameUrlLabel.textContent = url;
    frame.src        = currentProxyUrl;
    setStatus(`로드 중: ${url}`);
  }

  // ── Iframe load tracking ───────────────────────────────────────────────────
  frame.addEventListener('load', () => {
    try {
      // Extract real URL from proxy path inside the iframe
      const iframePath = frame.contentWindow?.location?.href || '';
      const m = iframePath.match(/[?&]url=([^&]+)/);
      if (m) {
        const real = decodeURIComponent(m[1]);
        currentRealUrl = real;
        frameUrlLabel.textContent = real;
        urlInput.value = real;
      }
    } catch {}

    if (isRecording) {
      // Page navigated during recording — re-send START so inject.js picks it up
      sendCtrl({ cmd: 'START' });
    }
  });

  // ── postMessage from iframe (inject.js) ─────────────────────────────────────
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d) return;

    if (d.__rtype === 'RECORDER_EVENT' && isRecording) {
      capturedEvents.push(d.event);
      setStatus(`녹화 중… ${capturedEvents.length}개 이벤트 캡처됨`);
      return;
    }

    if (d.__rtype === 'INJECT_READY') {
      setStatus(`페이지 준비됨: ${d.url || currentRealUrl}`);
      frameUrlLabel.textContent = d.url || currentRealUrl;
      if (isRecording) sendCtrl({ cmd: 'START' });
      return;
    }

    if (d.__rtype === 'REPLAY_DONE') {
      hideReplayOverlay();
      setStatus('재생 완료.');
      headerReplay.disabled = false;
      return;
    }
  });

  function sendCtrl(data) {
    try {
      frame.contentWindow?.postMessage({ __rfrom: 'RECORDER_CTRL', ...data }, '*');
    } catch {}
  }

  // ── Recording ───────────────────────────────────────────────────────────────
  function startRecording() {
    if (!currentRealUrl) {
      setStatus('먼저 URL을 입력하고 이동하세요.');
      return;
    }
    isRecording    = true;
    capturedEvents = [];
    recordBtn.classList.add('active');
    recordBtn.innerHTML = '<span class="dot"></span> 중지';
    recBadge.classList.remove('hidden');
    headerReplay.disabled = true;
    sendCtrl({ cmd: 'START' });
    setStatus('녹화 시작됨. 브라우저에서 자유롭게 상호작용하세요.');
  }

  async function stopRecording() {
    isRecording = false;
    sendCtrl({ cmd: 'STOP' });
    recordBtn.classList.remove('active');
    recordBtn.innerHTML = '<span class="dot"></span> 녹화';
    recBadge.classList.add('hidden');

    if (capturedEvents.length === 0) {
      setStatus('녹화된 이벤트가 없습니다.');
      return;
    }

    setStatus(`저장 중… (${capturedEvents.length}개 이벤트)`);
    try {
      const res  = await fetch('/api/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:   `녹화 #${recordings.length + 1}`,
          url:    currentRealUrl,
          events: capturedEvents,
        }),
      });
      const rec = await res.json();
      recordings.push(rec);
      selectedId = rec.id;
      renderList();
      headerReplay.disabled = false;
      setStatus(`저장 완료 — ${rec.name} (${rec.eventCount}개 이벤트)`);
    } catch (err) {
      setStatus('저장 실패: ' + err.message);
    }
  }

  // ── Replay (in-browser via inject.js) ───────────────────────────────────────
  async function replayInBrowser(id) {
    const meta = recordings.find(r => r.id === id);
    if (!meta) return;

    selectedId = id;
    renderList();
    headerReplay.disabled = true;
    showReplayOverlay(meta.name, 0, meta.eventCount);

    try {
      const res = await fetch(`/api/recordings/${id}`);
      const rec = await res.json();

      // Navigate to recorded URL
      navigate(rec.url);

      // Wait for inject.js to signal ready
      await waitForInjectReady(6000);
      await sleep(300);

      // Stream progress updates while replaying
      let done = 0;
      const total = rec.events.length;

      // Intercept REPLAY_DONE to update progress overlay
      const progressHandler = e => {
        if (e.data?.__rtype === 'RECORDER_EVENT') return; // ignore
        if (e.data?.__rtype === 'REPLAY_DONE') return;    // handled elsewhere
      };
      window.addEventListener('message', progressHandler);

      sendCtrl({ cmd: 'REPLAY', events: rec.events, speedFactor: 1.0 });

      // Approximate progress by polling event count
      const interval = setInterval(() => {
        done = Math.min(done + Math.ceil(total / 20), total);
        showReplayOverlay(meta.name, done, total);
        if (done >= total) clearInterval(interval);
      }, 200);

    } catch (err) {
      hideReplayOverlay();
      setStatus('재생 실패: ' + err.message);
      headerReplay.disabled = false;
    }
  }

  function waitForInjectReady(timeoutMs) {
    return new Promise(resolve => {
      const handler = e => {
        if (e.data?.__rtype === 'INJECT_READY') {
          window.removeEventListener('message', handler);
          resolve();
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => { window.removeEventListener('message', handler); resolve(); }, timeoutMs);
    });
  }

  // ── Puppeteer replay (server-side) ──────────────────────────────────────────
  async function replayPuppeteer(id) {
    try {
      setStatus('Puppeteer 재생 요청 중…');
      const res = await fetch(`/api/replay/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speedFactor: 1.0 }),
      });
      const data = await res.json();
      setStatus(data.message || 'Puppeteer 재생 시작됨.');
    } catch (err) {
      setStatus('Puppeteer 재생 실패: ' + err.message);
    }
  }

  // ── Delete recording ─────────────────────────────────────────────────────────
  async function deleteRecording(id) {
    try {
      await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
      recordings = recordings.filter(r => r.id !== id);
      if (selectedId === id) {
        selectedId = recordings.length > 0 ? recordings[recordings.length - 1].id : null;
        headerReplay.disabled = selectedId === null;
      }
      renderList();
      setStatus('녹화 삭제됨.');
    } catch (err) {
      setStatus('삭제 실패: ' + err.message);
    }
  }

  // ── Replay overlay ───────────────────────────────────────────────────────────
  let overlay = null;

  function showReplayOverlay(name, done, total) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'replay-overlay';
      overlay.innerHTML = `
        <div class="ov-box">
          <div class="ov-title">▶ 재생 중</div>
          <div class="ov-name" style="font-size:13px;margin-bottom:10px;color:#aaa"></div>
          <div class="ov-progress"></div>
          <button class="ov-cancel">취소</button>
        </div>`;
      overlay.querySelector('.ov-cancel').addEventListener('click', () => {
        sendCtrl({ cmd: 'STOP_REPLAY' });
        hideReplayOverlay();
        headerReplay.disabled = false;
        setStatus('재생 취소됨.');
      });
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.ov-name').textContent = name;
    overlay.querySelector('.ov-progress').textContent =
      total > 0 ? `${done} / ${total} 이벤트` : '준비 중…';
    overlay.classList.add('visible');
  }

  function hideReplayOverlay() {
    overlay?.classList.remove('visible');
  }

  // ── Render recording list ────────────────────────────────────────────────────
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
        const isSelected = rec.id === selectedId;
        const shortUrl   = trimUrl(rec.url);
        const time       = fmtTime(rec.createdAt);
        return `
<div class="rec-item${isSelected ? ' selected' : ''}" data-id="${rec.id}">
  <div class="rec-item-head">
    <span class="rec-num">#${rec.id}</span>
    <button class="rec-del" data-id="${rec.id}" title="삭제">✕</button>
  </div>
  <span class="rec-url" title="${esc(rec.url)}">${esc(shortUrl)}</span>
  <div class="rec-meta">
    <span>${rec.eventCount}개 이벤트</span>
    <span>${time}</span>
  </div>
  <div class="rec-actions">
    <button class="btn-rec-replay"    data-id="${rec.id}">▶ 재생</button>
    <button class="btn-rec-puppeteer" data-id="${rec.id}" title="Puppeteer로 실제 브라우저에서 재생">🤖 Puppeteer</button>
  </div>
</div>`;
      })
      .join('');
  }

  // ── Event delegation for list ────────────────────────────────────────────────
  recList.addEventListener('click', e => {
    const delBtn  = e.target.closest('.rec-del');
    const repBtn  = e.target.closest('.btn-rec-replay');
    const pupBtn  = e.target.closest('.btn-rec-puppeteer');
    const item    = e.target.closest('.rec-item');

    if (delBtn)  { e.stopPropagation(); deleteRecording(+delBtn.dataset.id);  return; }
    if (repBtn)  { e.stopPropagation(); replayInBrowser(+repBtn.dataset.id);  return; }
    if (pupBtn)  { e.stopPropagation(); replayPuppeteer(+pupBtn.dataset.id);  return; }
    if (item)    {
      selectedId = +item.dataset.id;
      headerReplay.disabled = false;
      renderList();
    }
  });

  // ── Toolbar bindings ─────────────────────────────────────────────────────────
  goBtn.addEventListener('click', () => navigate(urlInput.value));
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(urlInput.value); });

  recordBtn.addEventListener('click', () => {
    if (isRecording) stopRecording();
    else startRecording();
  });

  headerReplay.addEventListener('click', () => {
    if (selectedId !== null) replayInBrowser(selectedId);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function trimUrl(url) {
    try {
      const u = new URL(url);
      const p = u.pathname === '/' ? '' : u.pathname;
      return u.hostname + p;
    } catch { return url; }
  }

  function fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString('ko-KR'); }
    catch { return ''; }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Initial load ─────────────────────────────────────────────────────────────
  (async function init() {
    try {
      const res = await fetch('/api/recordings');
      recordings = await res.json();
      if (recordings.length > 0) {
        selectedId = recordings[recordings.length - 1].id;
        headerReplay.disabled = false;
      }
      renderList();
      setStatus('준비됨. URL을 입력하고 이동하세요.');
    } catch {
      setStatus('서버와 연결을 확인하세요.');
    }
  })();

})();
