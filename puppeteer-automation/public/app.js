/* Browser Automation Tool — Frontend Controller */
(function () {
  'use strict';

  const MAX_EVENTS = 10000; // Fix P2: hard cap to prevent memory runaway

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const urlInput      = document.getElementById('url-input');
  const goBtn         = document.getElementById('go-btn');
  const recordBtn     = document.getElementById('record-btn');
  const headerReplay  = document.getElementById('replay-btn');
  const speedSelect   = document.getElementById('speed-select'); // Fix U6
  const frame         = document.getElementById('browser-frame');
  const frameUrlLabel = document.getElementById('frame-url');
  const recBadge      = document.getElementById('rec-badge');
  const statusText    = document.getElementById('status-text');
  const recList       = document.getElementById('rec-list');
  const recCount      = document.getElementById('rec-count');

  // ── State ───────────────────────────────────────────────────────────────────
  let isRecording        = false;
  let capturedEvents     = [];
  let currentRealUrl     = '';
  let selectedId         = null;
  let recordings         = [];
  let replayingName      = '';
  let recordingStartTime = null; // Fix U1
  let initialInjectDone  = false; // Fix U1: detect first vs subsequent INJECT_READY

  // ── Status helper ───────────────────────────────────────────────────────────
  function setStatus(msg) { statusText.textContent = msg; }

  // ── Navigation ──────────────────────────────────────────────────────────────
  function navigate(rawUrl) {
    let url = rawUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    currentRealUrl = url;
    urlInput.value = url;
    frameUrlLabel.textContent = url;
    frame.src = `/proxy?url=${encodeURIComponent(url)}`;
    setStatus(`로드 중: ${url}`);
  }

  // ── Iframe load event (Fix U7: detect proxy error page) ───────────────────
  frame.addEventListener('load', () => {
    try {
      const doc = frame.contentDocument;
      // Fix U7: proxy sets data-proxy-error="true" on error pages
      if (doc?.documentElement?.dataset?.proxyError) {
        setStatus('⚠️ 페이지를 불러올 수 없습니다. URL을 확인하거나 다른 URL을 시도하세요.');
        return;
      }
      // Update URL bar from iframe location
      const href = frame.contentWindow?.location?.href || '';
      const m = href.match(/[?&]url=([^&]+)/);
      if (m) {
        const real = decodeURIComponent(m[1]);
        currentRealUrl = real;
        frameUrlLabel.textContent = real;
        urlInput.value = real;
      }
    } catch {}
  });

  // ── postMessage from iframe (inject.js) ─────────────────────────────────────
  window.addEventListener('message', e => {
    // Fix D1: only accept messages from our own iframe
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d) return;

    if (d.__rtype === 'RECORDER_EVENT') {
      if (!isRecording) return;
      // Fix P2: enforce max event cap
      if (capturedEvents.length >= MAX_EVENTS) {
        setStatus(`⚠️ 최대 이벤트 수(${MAX_EVENTS})에 도달했습니다. 녹화를 자동 중지합니다.`);
        stopRecording();
        return;
      }
      capturedEvents.push(d.event);
      setStatus(`녹화 중… ${capturedEvents.length}개 이벤트 캡처됨`);
      return;
    }

    if (d.__rtype === 'INJECT_READY') {
      const pageUrl = d.url || currentRealUrl;
      frameUrlLabel.textContent = pageUrl;

      if (isRecording) {
        // Fix U1: record a navigate event for pages after the first load
        if (initialInjectDone && capturedEvents.length > 0) {
          capturedEvents.push({
            type: 'navigate',
            url: pageUrl,
            t: Date.now() - recordingStartTime,
          });
        } else {
          initialInjectDone = true;
        }
        sendCtrl({ cmd: 'START' });
        setStatus(`녹화 중… ${capturedEvents.length}개 이벤트 캡처됨`);
      } else {
        setStatus(`페이지 준비됨: ${pageUrl}`);
      }
      return;
    }

    // Fix D5: real progress from inject.js (not approximated)
    if (d.__rtype === 'REPLAY_PROGRESS') {
      showReplayOverlay(replayingName, d.done, d.total);
      return;
    }

    if (d.__rtype === 'REPLAY_DONE') {
      hideReplayOverlay();
      setStatus(`재생 완료 — ${replayingName}`);
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
    isRecording        = true;
    capturedEvents     = [];
    recordingStartTime = Date.now(); // Fix U1
    initialInjectDone  = false;      // Fix U1
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
      const res = await fetch('/api/recordings', {
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

  // ── In-browser replay (Fix U1: multi-page segment replay) ─────────────────
  async function replayInBrowser(id) {
    const meta = recordings.find(r => r.id === id);
    if (!meta) return;

    selectedId = id;
    renderList();
    headerReplay.disabled = true;
    replayingName = meta.name;
    showReplayOverlay(meta.name, 0, meta.eventCount);

    try {
      const res = await fetch(`/api/recordings/${id}`);
      const rec = await res.json();

      // Fix U6: read speed from slider
      const speed = parseFloat(speedSelect?.value ?? '1');

      // Fix U1: split events at navigate boundaries → replay segment by segment
      const segments = splitByNavigate(rec.url, rec.events);

      for (const seg of segments) {
        navigate(seg.url);
        await waitForInjectReady(6000);
        await sleep(300);

        if (seg.events.length === 0) continue;

        const timeout = Math.max(30000, seg.events.length * 200);
        const donePromise = waitForReplayDone(timeout);

        sendCtrl({ cmd: 'REPLAY', events: seg.events, speedFactor: speed });

        await donePromise;
      }

      hideReplayOverlay();
      setStatus(`재생 완료 — ${rec.name}`);
    } catch (err) {
      hideReplayOverlay();
      setStatus('재생 실패: ' + err.message);
    } finally {
      headerReplay.disabled = false;
    }
  }

  // Fix U1: split events array at navigate markers
  function splitByNavigate(startUrl, events) {
    const segments = [];
    let current = { url: startUrl, events: [] };
    for (const ev of events) {
      if (ev.type === 'navigate') {
        segments.push(current);
        current = { url: ev.url, events: [] };
      } else {
        current.events.push(ev);
      }
    }
    segments.push(current);
    return segments;
  }

  function waitForInjectReady(timeoutMs) {
    return new Promise(resolve => {
      const handler = e => {
        if (e.source !== frame.contentWindow) return;
        if (e.data?.__rtype === 'INJECT_READY') {
          window.removeEventListener('message', handler);
          resolve();
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => { window.removeEventListener('message', handler); resolve(); }, timeoutMs);
    });
  }

  function waitForReplayDone(timeoutMs) {
    return new Promise(resolve => {
      const handler = e => {
        if (e.source !== frame.contentWindow) return;
        if (e.data?.__rtype === 'REPLAY_DONE') {
          window.removeEventListener('message', handler);
          resolve();
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => { window.removeEventListener('message', handler); resolve(); }, timeoutMs);
    });
  }

  // ── Puppeteer replay ─────────────────────────────────────────────────────────
  async function replayPuppeteer(id) {
    try {
      setStatus('Puppeteer 재생 요청 중…');
      const speed = parseFloat(speedSelect?.value ?? '1'); // Fix U6
      const res = await fetch(`/api/replay/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speedFactor: speed }),
      });
      const data = await res.json();
      setStatus(data.message || 'Puppeteer 재생 시작됨.');
    } catch (err) {
      setStatus('Puppeteer 재생 실패: ' + err.message);
    }
  }

  // ── Export (Fix U5) ────────────────────────────────────────────────────────
  async function exportJson(id) {
    try {
      const res = await fetch(`/api/recordings/${id}`);
      const rec = await res.json();
      const meta = recordings.find(r => r.id === id);
      const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
      triggerDownload(blob, `${safeName(meta?.name)}.json`);
      setStatus(`JSON 내보내기 완료 — ${meta?.name}`);
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
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeName(name) {
    return (name || 'recording').replace(/[^\w\s-]/g, '_');
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
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
          <div class="ov-name"></div>
          <div class="ov-bar-wrap"><div class="ov-bar-fill" id="ov-fill"></div></div>
          <div class="ov-progress" id="ov-progress">준비 중…</div>
          <button class="ov-cancel">취소</button>
        </div>`;
      overlay.querySelector('.ov-cancel').addEventListener('click', () => {
        sendCtrl({ cmd: 'STOP_REPLAY' }); // Fix B4
        hideReplayOverlay();
        headerReplay.disabled = false;
        setStatus('재생 취소됨.');
      });
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.ov-name').textContent = name;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    overlay.querySelector('#ov-fill').style.width = `${pct}%`;
    overlay.querySelector('#ov-progress').textContent =
      total > 0 ? `${done} / ${total} 이벤트 (${pct}%)` : '준비 중…';
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
        return `
<div class="rec-item${isSelected ? ' selected' : ''}" data-id="${rec.id}">
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
    <button class="btn-rec-replay"    data-id="${rec.id}">▶ 재생</button>
    <button class="btn-rec-puppeteer" data-id="${rec.id}" title="Puppeteer로 실제 브라우저에서 재생">🤖</button>
  </div>
  <div class="rec-export">
    <button class="btn-rec-json"   data-id="${rec.id}" title="JSON으로 내보내기">📥 JSON</button>
    <button class="btn-rec-script" data-id="${rec.id}" title="Puppeteer 스크립트로 내보내기">📜 Script</button>
  </div>
</div>`;
      })
      .join('');
  }

  // ── Event delegation for list ────────────────────────────────────────────────
  recList.addEventListener('click', e => {
    const del    = e.target.closest('.rec-del');
    const rep    = e.target.closest('.btn-rec-replay');
    const pup    = e.target.closest('.btn-rec-puppeteer');
    const xjson  = e.target.closest('.btn-rec-json');
    const xscript= e.target.closest('.btn-rec-script');
    const item   = e.target.closest('.rec-item');

    if (del)     { e.stopPropagation(); deleteRecording(+del.dataset.id);  return; }
    if (rep)     { e.stopPropagation(); replayInBrowser(+rep.dataset.id);  return; }
    if (pup)     { e.stopPropagation(); replayPuppeteer(+pup.dataset.id);  return; }
    if (xjson)   { e.stopPropagation(); exportJson(+xjson.dataset.id);     return; }
    if (xscript) { e.stopPropagation(); exportScript(+xscript.dataset.id); return; }
    if (item) {
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
