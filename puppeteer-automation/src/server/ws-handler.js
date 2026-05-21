"use strict";

const {
  dbGetMeta, dbAllMeta,
  dbLoadEvents, dbLoadResponses, dbLoadCookies, dbLoadToasts,
  dbSaveRecording, dbUpdateMeta, dbUpdateName,
  dbDeleteRecording, dbDeleteHistoryByRecording,
  dbFindInitByUrl,
} = require("./db");
const { runReplay, mapResponsesToEvents } = require("./replay");
const { isApiResponse } = require("../shared/api-filter");
const { isTrackerUrl } = require("../shared/blocklist");
const { pathUrl } = require("../shared/url");
const state = require("./state");
const { send, log } = require("./comms");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const SKIP_KEYS = new Set(["Process", "Unidentified", "Dead", "Compose", "OS"]);

// 초기화 녹화 확정 저장.
// navigate 후 pendingInitCap에 누적된 응답을 첫 사용자 입력 시점에 호출해 저장한다.
async function finalizeInitCap() {
  const cap = state.pendingInitCap;
  if (!cap) return;
  state.pendingInitCap = null;

  state.activePage.off("response", cap.handler);

  // 아직 body를 읽는 중인 응답이 있으면 최대 2초 대기
  if (cap.pending.size > 0)
    await Promise.race([Promise.allSettled([...cap.pending]), sleep(2000)]);

  if (cap.responses.length === 0) return;

  const existingInitId = dbFindInitByUrl(cap.url);
  if (existingInitId) {
    log("info", `[초기화] 이미 존재함 (id=${existingInitId}), 재녹화 생략`);
    return;
  }

  const navEv = { type: "navigate", url: cap.url, t: 0 };
  const events = mapResponsesToEvents([navEv], cap.responses);
  const newId = dbSaveRecording(
    "초기화", cap.url, 1, new Date().toISOString(),
    events, cap.responses, [...state.sessionCookies], [],
  );
  send({ type: "recordings", list: dbAllMeta() });
  log("info", `[초기화] 자동 저장 — id=${newId}, 응답 ${cap.responses.length}건`);
}

async function handleClientMessage(msg) {
  if (!state.activePage) {
    send({ type: "error", message: "브라우저 세션이 없습니다." });
    return;
  }

  switch (msg.type) {
    // ── Navigation ───────────────────────────────────────────────────────────
    case "navigate": {
      // 이전 navigate의 pendingInitCap이 남아 있으면 먼저 확정 저장
      await finalizeInitCap();

      state.firstNavigateDone = false;
      if (state.sessionCookies.length > 0)
        await state.activePage.setCookie(...state.sessionCookies);

      // 녹화/리플레이 중이 아닐 때만 초기화 캡처 세션 시작
      if (!state.isRecording) {
        const initCap = { responses: [], pending: new Set(), t0: Date.now(), url: msg.url };
        initCap.handler = (response) => {
          const url = response.url();
          if (url.startsWith("data:") || url.startsWith("blob:")) return;
          if (!isApiResponse(response)) return;
          if (isTrackerUrl(url)) return;
          const ct = (response.headers()["content-type"] || "").toLowerCase();
          const wantBody = /json|text\/plain|xml/.test(ct);
          const status = response.status();
          const t = Date.now() - initCap.t0;
          const purl = pathUrl(url);
          if (!wantBody) {
            initCap.responses.push({ url: purl, status, contentType: ct, body: null, t });
            return;
          }
          const p = response
            .buffer()
            .then((buf) => initCap.responses.push({ url: purl, status, contentType: ct, body: buf.toString("utf8"), t }))
            .catch(() => initCap.responses.push({ url: purl, status, contentType: ct, body: null, t }))
            .finally(() => initCap.pending.delete(p));
          initCap.pending.add(p);
        };
        state.activePage.on("response", initCap.handler);
        // 핸들러를 state에 보관 — 첫 사용자 입력 시 finalizeInitCap()이 확정 저장
        state.pendingInitCap = initCap;
      }

      await state.activePage.goto(msg.url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // 페이지 초기 로드 버스트가 끝날 때까지 대기.
      // 핸들러는 state.pendingInitCap에 살아있어 이후 지연 요청도 계속 캡처.
      if (state.pendingInitCap) {
        try {
          await state.activePage.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 });
        } catch {}
        // 초기 버스트의 in-flight body 읽기 완료 대기 (이후 요청은 계속 캡처)
        if (state.pendingInitCap.pending.size > 0)
          await Promise.race([Promise.allSettled([...state.pendingInitCap.pending]), sleep(1000)]);
      }

      break;
    }

    // ── Cookie management ────────────────────────────────────────────────────
    case "set-cookies": {
      state.sessionCookies = (msg.cookies ?? []).filter((c) => c.name && c.value);
      if (state.sessionCookies.length > 0) {
        await state.activePage.setCookie(...state.sessionCookies);
        console.log(`[Cookies] Set ${state.sessionCookies.length} cookie(s)`);
      }
      send({ type: "cookies-applied", count: state.sessionCookies.length });
      break;
    }

    // ── Mouse events ─────────────────────────────────────────────────────────
    case "mousemove":
      await state.activePage.mouse.move(msg.x, msg.y);
      break;
    case "mousedown":
      await state.activePage.mouse.move(msg.x, msg.y);
      await state.activePage.mouse.down({ button: msg.button ?? "left" });
      break;
    case "mouseup":
      await state.activePage.mouse.move(msg.x, msg.y);
      await state.activePage.mouse.up({ button: msg.button ?? "left" });
      break;
    case "click":
      await finalizeInitCap();
      await state.activePage.mouse.click(msg.x, msg.y, { button: msg.button ?? "left" });
      break;
    case "dblclick":
      await finalizeInitCap();
      await state.activePage.mouse.click(msg.x, msg.y, { clickCount: 2 });
      break;
    case "wheel":
      await finalizeInitCap();
      await state.activePage.mouse.wheel({ deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0 });
      break;

    // ── Keyboard events ───────────────────────────────────────────────────────
    case "keydown": {
      await finalizeInitCap();
      const key = msg.key === " " ? "Space" : msg.key;
      if (!SKIP_KEYS.has(key)) {
        try { await state.activePage.keyboard.down(key); } catch {}
      }
      break;
    }
    case "keyup": {
      const key = msg.key === " " ? "Space" : msg.key;
      if (!SKIP_KEYS.has(key)) {
        try { await state.activePage.keyboard.up(key); } catch {}
      }
      break;
    }

    // ── Recording ─────────────────────────────────────────────────────────────
    case "start-recording":
      await finalizeInitCap();
      state.isRecording = true;
      state.capturedEvents = [];
      state.capturedResponses = [];
      state.capturedToasts = [];
      state.pendingRespPromises = new Set();
      state.recordingStartTime = null;
      state.recordingStartUrl = state.currentUrl;
      state.firstNavigateDone = true;
      send({ type: "recording-started" });
      console.log(`[Recording] Started @ ${state.recordingStartUrl}`);
      break;

    case "stop-recording": {
      state.isRecording = false;
      if (state.pendingRespPromises.size > 0)
        await Promise.race([
          Promise.allSettled([...state.pendingRespPromises]),
          sleep(2000),
        ]);
      console.log(
        `[Recording] Stopped — ${state.capturedEvents.length} events, ${state.capturedResponses.length} responses`,
      );
      if (state.capturedEvents.length === 0) {
        send({ type: "recording-empty" });
        break;
      }
      const eventsWithMapping = mapResponsesToEvents(
        [...state.capturedEvents],
        [...state.capturedResponses],
      );
      const triggeredCount = eventsWithMapping.filter((e) => e.triggeredUrls?.length).length;
      if (triggeredCount > 0)
        console.log(`[Recording] Event→HTTP mapping: ${triggeredCount} events mapped`);

      const createdAt = new Date().toISOString();
      const newId = dbSaveRecording(
        `테스트 케이스 #?`,
        state.recordingStartUrl || state.currentUrl,
        state.capturedEvents.length,
        createdAt,
        eventsWithMapping,
        [...state.capturedResponses],
        [...state.sessionCookies],
        [...state.capturedToasts],
      );
      dbUpdateName(newId, `테스트 케이스 #${newId}`);
      const meta = dbGetMeta(newId);
      send({ type: "recording-saved", recording: meta });
      send({ type: "recordings", list: dbAllMeta() });
      console.log(`[Recording] Saved as id=${newId}`);
      break;
    }

    // ── Cancel replay / suite ────────────────────────────────────────────────
    case "cancel-replay":
      state.replayCancelled = true;
      log("warn", "재생 취소 요청됨");
      break;

    // ── Replay ────────────────────────────────────────────────────────────────
    case "replay": {
      await finalizeInitCap();
      const meta = dbGetMeta(msg.id);
      if (!meta) break;
      const events = dbLoadEvents(msg.id);
      if (!events) break;
      const responses = dbLoadResponses(msg.id);
      const cookies = dbLoadCookies(msg.id);
      const toasts = dbLoadToasts(msg.id);
      await runReplay(
        msg.id,
        events,
        responses,
        meta.url,
        false,
        cookies,
        toasts,
        msg.compareHttp !== false,
        !!msg.mockReplay,
      );
      break;
    }

    // ── Suite (batch replay) ──────────────────────────────────────────────────
    case "run-suite": {
      const ids = Array.isArray(msg.ids)
        ? msg.ids.filter((x) => typeof x === "number")
        : [];
      if (ids.length === 0) break;

      send({ type: "suite-started", total: ids.length });
      log("info", `━━ 스위트 실행 시작: ${ids.length}개 테스트 ━━`);

      let suitePass = 0, suiteFail = 0;
      state.replayCancelled = false;

      for (let i = 0; i < ids.length; i++) {
        if (state.replayCancelled) {
          log("warn", `스위트 취소됨 (${i}/${ids.length} 완료)`);
          break;
        }
        const id = ids[i];
        const meta = dbGetMeta(id);
        if (!meta) { suiteFail++; continue; }
        const events = dbLoadEvents(id);
        if (!events) { suiteFail++; continue; }
        const responses = dbLoadResponses(id);
        const cookies = dbLoadCookies(id);
        const toasts = dbLoadToasts(id);

        send({ type: "suite-item-started", index: i, total: ids.length, name: meta.name });
        log("info", `━━ [${i + 1}/${ids.length}] ${meta.name} ━━`);

        const result = await runReplay(
          id,
          events,
          responses,
          meta.url,
          true,
          cookies,
          toasts,
          msg.compareHttp !== false,
          !!msg.mockReplay,
        );

        if (result.failed === 0) suitePass++;
        else suiteFail++;

        send({
          type: "suite-item-done",
          index: i,
          total: ids.length,
          name: meta.name,
          passed: result.passed,
          failed: result.failed,
          recTotal: result.total,
        });
      }

      log(
        suiteFail === 0 ? "success" : "fail",
        `━━ 스위트 완료: 성공 ${suitePass} / 실패 ${suiteFail} (총 ${ids.length}개) ━━`,
      );
      send({ type: "suite-done", total: ids.length, passed: suitePass, failed: suiteFail });
      break;
    }

    // ── Update metadata (name / description / tags) ───────────────────────────
    case "update-recording": {
      const { id, name, description, tags } = msg;
      if (!dbGetMeta(id)) break;
      dbUpdateMeta(
        id,
        (name || "").trim(),
        (description || "").trim(),
        Array.isArray(tags) ? tags : [],
      );
      send({ type: "recordings", list: dbAllMeta() });
      break;
    }

    // ── Delete ────────────────────────────────────────────────────────────────
    case "delete-recording": {
      dbDeleteHistoryByRecording(msg.id);
      dbDeleteRecording(msg.id);
      send({ type: "recordings", list: dbAllMeta() });
      break;
    }

    // ── Analyze ───────────────────────────────────────────────────────────────
    case "analyze": {
      await finalizeInitCap();
      const { runAnalysis } = require("./analyzer");
      // Run async without blocking the WS handler — progress sent via send()
      runAnalysis(msg.url || state.currentUrl).catch((err) => {
        log("fail", `[분석] 처리되지 않은 오류: ${err.message}`);
      });
      break;
    }
    case "cancel-analyze":
      state.analysisCancelled = true;
      log("warn", "분석 취소 요청됨");
      break;
  }
}

module.exports = { handleClientMessage };
