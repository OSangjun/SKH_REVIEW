"use strict";

const {
  dbGetMeta, dbAllMeta,
  dbLoadEvents, dbLoadResponses, dbLoadCookies, dbLoadToasts,
  dbSaveRecording, dbUpdateMeta, dbUpdateName,
  dbDeleteRecording, dbDeleteHistoryByRecording,
} = require("./db");
const { runReplay, mapResponsesToEvents } = require("./replay");
const state = require("./state");
const { send, log } = require("./comms");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleClientMessage(msg) {
  if (!state.activePage) {
    send({ type: "error", message: "브라우저 세션이 없습니다." });
    return;
  }

  switch (msg.type) {
    // ── Navigation ───────────────────────────────────────────────────────────
    case "navigate": {
      state.firstNavigateDone = false;
      if (state.sessionCookies.length > 0)
        await state.activePage.setCookie(...state.sessionCookies);
      await state.activePage.goto(msg.url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
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
      await state.activePage.mouse.click(msg.x, msg.y, { button: msg.button ?? "left" });
      break;
    case "dblclick":
      await state.activePage.mouse.click(msg.x, msg.y, { clickCount: 2 });
      break;
    case "wheel":
      await state.activePage.mouse.wheel({ deltaX: msg.deltaX ?? 0, deltaY: msg.deltaY ?? 0 });
      break;

    // ── Keyboard events ───────────────────────────────────────────────────────
    case "keydown":
      await state.activePage.keyboard.down(msg.key === " " ? "Space" : msg.key);
      break;
    case "keyup":
      await state.activePage.keyboard.up(msg.key === " " ? "Space" : msg.key);
      break;

    // ── Recording ─────────────────────────────────────────────────────────────
    case "start-recording":
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
  }
}

module.exports = { handleClientMessage };
