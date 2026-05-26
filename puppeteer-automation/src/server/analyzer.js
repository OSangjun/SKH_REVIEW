"use strict";

/**
 * analyzer.js — 멀티 에이전트 분석 시스템
 *
 * 실행 구조 (2-Phase):
 *   Phase 1 — 에이전트 팀 병렬 분석 (AgentBus 기반 실시간 에이전트 간 통신)
 *     UIAgent      : DOM/화면 구조 분석. 조회 조건 데이터 필요 시 DB 에이전트에게 ask_agent
 *     UISourceAgent: 3-tier 소스체인 탐색 (UI→BFF→Backend)
 *     FrontendAgent: Vue Router → 컴포넌트 → API 클라이언트 탐색
 *     BackendAgent : 컨트롤러/서비스 탐색. DB 에이전트 질의에 answer_query로 응답
 *     DBAgent      : 테스트 데이터 조회. 테이블 모를 시 Backend에 ask_agent, UI 요청에 answer_query
 *   Phase 2 — LeadAgent + RecordingAgent
 *     LeadAgent    : 팀 결과 취합 → 테스트 케이스 도출
 *     RecordingAgent: 각 테스트 케이스를 브라우저에서 직접 레코딩
 *
 * 에이전트 간 통신 (AgentBus):
 *   ask_agent(target, question) → 대상 에이전트에게 실시간 질의 (응답 대기, 90초 타임아웃)
 *   answer_query(query_id, answer) → 수신된 질의에 답변
 *
 *   예시 통신 흐름:
 *     UIAgent → ask_agent("db", "날짜범위·상태코드 샘플 데이터 요청")
 *     DBAgent → ask_agent("backend", "주문 테이블·상태코드 컬럼 확인")
 *     BackendAgent → answer_query(id, "ORDER 테이블, STATUS_CD 컬럼...")
 *     DBAgent → DB 조회 → answer_query(id, {dateRange: ..., statusCd: ...})
 *     UIAgent ← 실제 조회 조건 데이터 수신
 *
 * 통신 프로토콜 (WebSocket → 클라이언트):
 *   analyze-started   { url }
 *   analyze-phase     { phase, total, label }
 *   analyze-agent     { agent, label, status, message }
 *   analyze-finding   { agent, label, findingType, title, description }
 *   analyze-synthesis { testCases: [{name, expectedResult}] }
 *   analyze-recording { name, index, total }
 *   analyze-done      { created }
 *   analyze-error     { message }
 */

const Anthropic = require("@anthropic-ai/sdk");
const fs        = require("fs");
const path      = require("path");
const state     = require("./state");
const { send, log } = require("./comms");
const { dbSaveRecording, dbUpdateName, dbAllMeta } = require("./db");
const { mapResponsesToEvents } = require("./replay");
const { isApiResponse } = require("../shared/api-filter");
const { isTrackerUrl }  = require("../shared/blocklist");
const { pathUrl }       = require("../shared/url");
const gitlab = require("./gitlab-client");
const db     = require("./db-client");
const {
  projectFromUrl,
  projectFromEndpoint,
  branchFor,
} = require("./source-mapping");

const SKIP_KEYS = new Set(["Process", "Unidentified", "Dead", "Compose", "OS"]);
const client    = new Anthropic();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitIdle(timeout = 8000, idleTime = 500) {
  try { await state.activePage.waitForNetworkIdle({ idleTime, timeout }); } catch {}
}

// ── 리포트 디렉터리 (각 에이전트 마크다운 리포트 저장 경로) ────────────────────
const REPORT_DIR = path.join(__dirname, "..", "..", "reports");

function resetReportDir() {
  fs.rmSync(REPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

// ── 공통 도구 정의 ──────────────────────────────────────────────────────────

// 에이전트가 비즈니스 로직 발견 시 즉시 리드에이전트에게 전달하는 도구
const SEND_FINDING_TOOL = {
  name: "send_finding",
  description: "비즈니스 로직, API 엔드포인트, 유효성 규칙, 에러 시나리오 등을 발견했을 때 즉시 리드 에이전트에게 전달합니다. 중요한 발견사항이 있을 때마다 분석을 멈추지 말고 이 도구로 전달하세요.",
  input_schema: {
    type: "object",
    properties: {
      findingType: {
        type: "string",
        enum: ["business_logic", "api_endpoint", "validation_rule", "error_scenario", "db_table", "auth_rule", "test_scenario"],
        description: "발견 유형",
      },
      title:       { type: "string", description: "발견 내용 제목 (간결하게)" },
      description: { type: "string", description: "상세 설명" },
      data:        { type: "object", description: "관련 데이터 (선택)" },
    },
    required: ["findingType", "title"],
  },
};

const REPORT_TOOL = {
  name: "report_findings",
  description: "분석을 모두 마친 후 최종 결과를 구조화된 JSON으로 제출합니다. 분석 완료 시 반드시 이 도구를 마지막으로 호출하세요.",
  input_schema: {
    type: "object",
    properties: {
      findings: { type: "object", description: "최종 분석 결과 (자유 형식 JSON)" },
    },
    required: ["findings"],
  },
};

const WRITE_REPORT_TOOL = {
  name: "write_report",
  description: "분석 결과를 마크다운 리포트 파일로 저장합니다. report_findings 호출 직전에 반드시 먼저 호출하세요.",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "마크다운 형식의 분석 리포트 전문 (제목·요약·발견사항 포함)" },
    },
    required: ["content"],
  },
};

const READ_REPORT_TOOL = {
  name: "read_report",
  description: "에이전트가 작성한 분석 리포트 파일을 읽습니다.",
  input_schema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        enum: ["findings-summary", "ui", "ui-source", "frontend", "backend", "db"],
        description: "읽을 리포트 종류. findings-summary: 전체 발견 목록 요약",
      },
    },
    required: ["agent"],
  },
};

const GITLAB_TOOLS = [
  {
    name: "gitlab_list_files",
    description: "GitLab 저장소 특정 경로의 파일/디렉터리 목록을 반환합니다.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "조회 경로 (빈 문자열이면 루트)" },
        ref:  { type: "string", description: "브랜치/태그 (기본값: main)" },
      },
      required: [],
    },
  },
  {
    name: "gitlab_get_file",
    description: "GitLab 저장소에서 특정 파일의 전체 내용을 반환합니다.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "파일 경로 (예: src/views/Login.vue)" },
        ref:       { type: "string", description: "브랜치/태그 (기본값: main)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "gitlab_search_code",
    description: "GitLab 저장소 전체에서 코드를 검색합니다.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "검색어" } },
      required: ["query"],
    },
  },
];

// project 를 명시적으로 받는 동적 도구. UI 소스 분석에서 여러 프로젝트를
// 가로질러 조회할 때 사용한다. project 미지정 시 derive_project / page URL 에서
// 직접 얻어 호출자가 채워야 한다.
const GITLAB_IN_TOOLS = [
  {
    name: "gitlab_list_files_in",
    description: "지정한 GitLab 프로젝트의 경로 아래 파일/디렉터리 목록을 반환합니다.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "GitLab 프로젝트 경로 (예: group/repo) 또는 숫자 ID" },
        path:    { type: "string", description: "조회 경로 (빈 문자열이면 루트)" },
        ref:     { type: "string", description: "브랜치/태그 (생략 시 매핑표 또는 main)" },
      },
      required: ["project"],
    },
  },
  {
    name: "gitlab_get_file_in",
    description: "지정한 GitLab 프로젝트의 특정 파일 전체 내용을 반환합니다.",
    input_schema: {
      type: "object",
      properties: {
        project:   { type: "string", description: "GitLab 프로젝트 경로 또는 숫자 ID" },
        file_path: { type: "string", description: "파일 경로 (예: src/router/index.ts)" },
        ref:       { type: "string", description: "브랜치/태그 (생략 시 매핑표 또는 main)" },
      },
      required: ["project", "file_path"],
    },
  },
  {
    name: "gitlab_search_code_in",
    description: "지정한 GitLab 프로젝트 전체에서 코드를 검색합니다.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "GitLab 프로젝트 경로 또는 숫자 ID" },
        query:   { type: "string", description: "검색어" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "derive_project_from_url",
    description:
      "페이지 URL 또는 API 엔드포인트 URL/경로에서 첫 path 세그먼트를 추출해 " +
      "GitLab 프로젝트명을 결정합니다. 예: '/order/list' → 'order'.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "URL 또는 경로" } },
      required: ["url"],
    },
  },
  {
    name: "get_branch_for_project",
    description:
      "CLAUDE.md 의 '소스 프로젝트 브랜치 매핑' 표에서 해당 프로젝트의 " +
      "기본 브랜치를 조회합니다. 매핑이 없으면 'main' 반환.",
    input_schema: {
      type: "object",
      properties: { project: { type: "string", description: "프로젝트명" } },
      required: ["project"],
    },
  },
];

const BROWSER_TOOLS = [
  {
    name: "browser_screenshot",
    description: "현재 브라우저 화면의 스크린샷을 base64 JPEG로 반환합니다.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_navigate",
    description: "브라우저를 특정 URL로 이동합니다.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "이동할 URL" } },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description: "CSS 선택자 또는 좌표로 요소를 클릭합니다.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 선택자" },
        x:        { type: "number" },
        y:        { type: "number" },
        label:    { type: "string", description: "요소 텍스트 레이블 (동명 요소 구분)" },
      },
      required: [],
    },
  },
  {
    name: "browser_type",
    description: "입력 필드에 텍스트를 입력합니다. 기존 값은 삭제됩니다.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 선택자" },
        text:     { type: "string", description: "입력할 텍스트" },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_key_press",
    description: "키보드 키를 누릅니다 (예: Enter, Tab, Escape).",
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "키 이름 (예: Enter, Tab)" } },
      required: ["key"],
    },
  },
  {
    name: "browser_scroll",
    description: "페이지를 특정 위치로 스크롤합니다.",
    input_schema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
  },
  {
    name: "browser_get_page_info",
    description: "현재 페이지 URL, 제목, 입력 요소/버튼 목록을 반환합니다.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

function buildDbTools(configuredDbs) {
  if (!configuredDbs.length) return [];
  return [{
    name: "db_query",
    description: `DB에 SELECT 쿼리를 실행합니다. db 파라미터로 접속할 DB를 지정하세요.\n- local: 업무/도메인 데이터 (사용자, 거래, 계정 등)\n- center: 공통/마스터 데이터 (공통코드, 권한, 기준 데이터 등)`,
    input_schema: {
      type: "object",
      properties: {
        sql:    { type: "string", description: "실행할 SELECT SQL" },
        params: { type: "array",  items: { type: "string" }, description: "바인딩 파라미터" },
        db:     { type: "string", enum: configuredDbs, description: `접속할 DB (${configuredDbs.join(" | ")})` },
      },
      required: ["sql", "db"],
    },
  }];
}

// ── 도구 실행기 ─────────────────────────────────────────────────────────────

async function execGitlab(name, input) {
  switch (name) {
    case "gitlab_list_files":  return { files: await gitlab.listFiles(input.path || "", input.ref || "main") };
    case "gitlab_get_file":    return { content: await gitlab.getFile(input.file_path, input.ref || "main") };
    case "gitlab_search_code": return { results: await gitlab.searchCode(input.query) };

    // ── project 를 명시적으로 받는 동적 버전 ──
    case "gitlab_list_files_in": {
      const proj = input.project;
      if (!proj) return { error: "project is required" };
      const ref = input.ref || branchFor(proj);
      return { files: await gitlab.listFilesIn(proj, input.path || "", ref), ref };
    }
    case "gitlab_get_file_in": {
      const proj = input.project;
      if (!proj) return { error: "project is required" };
      const ref = input.ref || branchFor(proj);
      return { content: await gitlab.getFileIn(proj, input.file_path, ref), ref };
    }
    case "gitlab_search_code_in": {
      const proj = input.project;
      if (!proj) return { error: "project is required" };
      return { results: await gitlab.searchCodeIn(proj, input.query) };
    }
    case "derive_project_from_url": {
      const url = input.url || "";
      const proj = /^https?:\/\//.test(url) ? projectFromUrl(url) : projectFromEndpoint(url);
      return { project: proj };
    }
    case "get_branch_for_project": {
      return { project: input.project, branch: branchFor(input.project) };
    }

    default: return { error: `알 수 없는 GitLab 도구: ${name}` };
  }
}

async function execDb(name, input) {
  if (name !== "db_query") return { error: `알 수 없는 도구: ${name}` };
  const sql = (input.sql || "").trim();
  if (!/^select/i.test(sql)) return { error: "SELECT 쿼리만 허용됩니다." };
  const dbName = input.db || "local";
  const rows = await db.query(sql, input.params || [], dbName);
  return { rows, count: rows.length, db: dbName };
}

// ── 레코딩 상태 ─────────────────────────────────────────────────────────────

let _recStartTime = null;
let _recEvents    = [];
let _recResponses = [];
let _recPending   = new Set();
let _recHandler   = null;
let _recName      = "";

function startRecording(name) {
  _recName      = name;
  _recStartTime = Date.now();
  _recEvents    = [{ type: "navigate", url: state.currentUrl, t: 0 }];
  _recResponses = [];
  _recPending   = new Set();

  _recHandler = (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    if (isTrackerUrl(url)) return;
    const ct     = (response.headers()["content-type"] || "").toLowerCase();
    const status = response.status();
    const t      = Date.now() - _recStartTime;
    const purl   = pathUrl(url);
    if (!/json|text\/plain|xml/.test(ct)) {
      _recResponses.push({ url: purl, status, contentType: ct, body: null, t });
      return;
    }
    const p = response
      .buffer()
      .then((buf) => _recResponses.push({ url: purl, status, contentType: ct, body: buf.toString("utf8"), t }))
      .catch(() =>  _recResponses.push({ url: purl, status, contentType: ct, body: null, t }))
      .finally(() => _recPending.delete(p));
    _recPending.add(p);
  };
  state.activePage.on("response", _recHandler);
}

async function stopRecording() {
  if (!_recHandler) return null;
  state.activePage.off("response", _recHandler);
  _recHandler = null;
  if (_recPending.size > 0)
    await Promise.race([Promise.allSettled([..._recPending]), sleep(2000)]);
  if (_recEvents.length <= 1) return null;
  const eventsWithMap = mapResponsesToEvents([..._recEvents], [..._recResponses]);
  const id = dbSaveRecording(
    _recName, state.currentUrl, _recEvents.length,
    new Date().toISOString(), eventsWithMap, [..._recResponses],
    [...state.sessionCookies], [],
  );
  dbUpdateName(id, _recName);
  return id;
}

function addRecordedEvent(ev) {
  if (!_recHandler) return;
  _recEvents.push({ ...ev, t: Date.now() - _recStartTime });
}

async function execBrowser(name, input) {
  const page = state.activePage;
  if (!page) return { error: "브라우저 세션이 없습니다." };

  switch (name) {
    case "browser_screenshot": {
      const buf = await page.screenshot({ type: "jpeg", quality: 75 });
      return { image: buf.toString("base64"), mimeType: "image/jpeg" };
    }
    case "browser_navigate": {
      if (state.sessionCookies.length > 0) await page.setCookie(...state.sessionCookies);
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitIdle(8000, 500);
      if (_recHandler) addRecordedEvent({ type: "navigate", url: input.url });
      return { url: page.url() };
    }
    case "browser_click": {
      let clicked = false;
      if (input.selector) {
        try {
          const handles = await page.$$(input.selector);
          let el = handles[0];
          if (handles.length > 1 && input.label) {
            for (const h of handles) {
              const txt = await h.evaluate((e) => (e.innerText || e.textContent || "").trim());
              if (txt === input.label) { el = h; break; }
            }
          }
          if (el) { await el.click(); clicked = true; }
        } catch {}
      }
      if (!clicked && typeof input.x === "number") {
        await page.mouse.click(input.x, input.y);
        clicked = true;
      }
      if (clicked) {
        await waitIdle(6000, 500);
        if (_recHandler) addRecordedEvent({ type: "click", selector: input.selector, label: input.label, x: input.x, y: input.y });
      }
      return { clicked };
    }
    case "browser_type": {
      if (input.selector) {
        try {
          const el = await page.$(input.selector);
          if (el) {
            await el.click({ clickCount: 3 });
            await el.type(input.text || "");
            if (_recHandler) addRecordedEvent({ type: "input", selector: input.selector, value: input.text });
            return { typed: true };
          }
        } catch {}
      }
      await page.keyboard.type(input.text || "");
      if (_recHandler) addRecordedEvent({ type: "input", selector: input.selector, value: input.text });
      return { typed: true };
    }
    case "browser_key_press": {
      const key = input.key === " " ? "Space" : input.key;
      if (!SKIP_KEYS.has(key)) {
        try { await page.keyboard.press(key); } catch {}
        await waitIdle(6000, 500);
        if (_recHandler) addRecordedEvent({ type: "keydown", key: input.key });
      }
      return { key: input.key };
    }
    case "browser_scroll": {
      await page.evaluate((x, y) => window.scrollTo(x, y), input.x, input.y);
      if (_recHandler) addRecordedEvent({ type: "scroll", scrollX: input.x, scrollY: input.y });
      return { scrolled: true };
    }
    case "browser_get_page_info": {
      return page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input,textarea,select,button"))
          .slice(0, 40).map((el) => ({
            tag: el.tagName.toLowerCase(), type: el.type || null,
            id: el.id || null, name: el.name || null,
            placeholder: el.placeholder || null,
            text: (el.innerText || el.textContent || "").trim().slice(0, 80),
            visible: el.getBoundingClientRect().width > 0,
          }));
        return { url: location.href, title: document.title, inputs };
      });
    }
    default: return { error: `알 수 없는 브라우저 도구: ${name}` };
  }
}

// ── 공통 에이전트 러너 ──────────────────────────────────────────────────────

function agentMsg(agent, label, status, message) {
  send({ type: "analyze-agent", agent, label, status, message });
  const lvl = status === "error" ? "fail" : status === "done" ? "success" : "info";
  log(lvl, `[${label}] ${message.slice(0, 200)}`);
}

function phaseMsg(phase, total, label) {
  send({ type: "analyze-phase", phase, total, label });
  log("info", `━━ Phase ${phase}/${total}: ${label} ━━`);
}

function findingMsg(agent, label, findingType, title, description) {
  send({ type: "analyze-finding", agent, label, findingType, title, description: description || "" });
  log("info", `[${label}] 📌 ${title}`);
}

// 에이전트가 발견한 findings를 누적하는 공유 저장소 (Lead Agent에게 전달)
let _sharedFindings = [];

function resetFindings() { _sharedFindings = []; }

// 에이전트 표시 순번 (낮을수록 앞 순번)
const AGENT_ORDER = { "ui": 1, "ui-source": 2, "frontend": 3, "backend": 4, "db": 5 };

// ── 에이전트 간 실시간 통신 버스 ────────────────────────────────────────────────
class AgentBus {
  constructor() {
    this._inbox   = {};        // agentName → Array<{id, from, question}>
    this._pending = new Map(); // queryId → {resolve, reject}
    this._seq     = 0;
    this._closed  = new Map(); // agentName → label (종료된 에이전트 추적)
  }
  register(name) { this._inbox[name] = []; }

  ask(from, to, question, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      // 대상 에이전트가 이미 종료된 경우 즉시 응답 (90초 대기 없음)
      if (this._closed.has(to)) {
        const label = this._closed.get(to);
        agentMsg(from, from, "progress", `↩ [즉시] ${to} 에이전트 이미 종료 — 자동 응답`);
        resolve(`[${label} 분석이 완료되어 질의에 답변할 수 없습니다. 현재까지 수집된 findings를 참고하세요.]`);
        return;
      }

      const id = ++this._seq;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          resolve(`[타임아웃: ${to} 에이전트가 ${timeoutMs / 1000}초 내에 응답하지 않았습니다.]`);
        }
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (ans) => { clearTimeout(timer); resolve(ans); },
        reject:  (err) => { clearTimeout(timer); reject(err); },
      });
      if (!this._inbox[to]) this._inbox[to] = [];
      this._inbox[to].push({ id, from, question });
    });
  }

  drain(name) {
    const msgs = this._inbox[name] || [];
    this._inbox[name] = [];
    return msgs;
  }
  reply(id, answer) {
    const p = this._pending.get(id);
    if (p) { p.resolve(answer); this._pending.delete(id); }
  }

  // 에이전트 종료 시:
  //   1. _closed에 등록 → 이후 도착하는 질의는 ask()에서 즉시 응답
  //   2. 종료 시점에 이미 inbox에 있던 질의는 drain 후 일괄 자동 답변
  closeAgent(name, label) {
    this._closed.set(name, label);
    for (const q of this.drain(name)) {
      agentMsg(name, label, "progress", `↩ [종료] 질의 ${q.id} 자동 답변`);
      this.reply(q.id, `[${label} 분析이 완료되어 질의에 답변할 수 없습니다. 현재까지 수집된 findings를 참고하세요.]`);
    }
  }

  // 앞 순번(낮은 AGENT_ORDER) 에이전트가 모두 종료될 때까지 대기.
  // 대기 중에도 inbox에 쌓인 질의를 주기적으로 자동 답변하여 대기 에이전트 타임아웃 방지.
  async waitAndDrainUntilPredecessorsDone(name, label, maxWaitMs = 300000) {
    const myOrder     = AGENT_ORDER[name] || 0;
    const predecessors = Object.entries(AGENT_ORDER)
      .filter(([n, o]) => o < myOrder)
      .map(([n]) => n);
    if (!predecessors.length) return;

    const deadline = Date.now() + maxWaitMs;
    agentMsg(name, label, "progress", `선행 에이전트 종료 대기: [${predecessors.join(", ")}]`);

    while (Date.now() < deadline) {
      if (predecessors.every((n) => this._closed.has(n))) break;
      for (const q of this.drain(name)) {
        agentMsg(name, label, "progress", `↩ [대기중] 질의 ${q.id} 자동 답변`);
        this.reply(q.id, `[${label} 분析이 완료되어 대기 중입니다. 현재까지 수집된 findings를 참고하세요.]`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const ASK_AGENT_TOOL = {
  name: "ask_agent",
  description: "다른 분석 에이전트에게 정보를 요청합니다. 상대방이 응답할 때까지 기다립니다 (최대 90초).",
  input_schema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["ui", "ui-source", "frontend", "backend", "db"],
        description: "대상 에이전트 이름",
      },
      question: { type: "string", description: "요청할 내용 (구체적으로 기술)" },
    },
    required: ["target", "question"],
  },
};

const ANSWER_QUERY_TOOL = {
  name: "answer_query",
  description: "다른 에이전트의 질의에 답변합니다.",
  input_schema: {
    type: "object",
    properties: {
      query_id: { type: "number", description: "질의 ID (질의 메시지에 포함된 값)" },
      answer:   { type: "string", description: "답변 내용 (JSON 문자열 또는 텍스트)" },
    },
    required: ["query_id", "answer"],
  },
};

/**
 * 범용 에이전트 루프
 * - send_finding   : 중간 발견 즉시 전달 (웹소켓 + _sharedFindings)
 * - report_findings: 최종 결과 제출 후 루프 종료
 * - ask_agent      : (bus 제공 시) 다른 에이전트에게 실시간 질의
 * - answer_query   : (bus 제공 시) 수신된 질의에 답변
 */
async function runAgent({ name, label, tools, systemPrompt, userMessage, maxTurns = 40, execTool, bus }) {
  agentMsg(name, label, "start", "시작");

  const busTools = bus ? [ASK_AGENT_TOOL, ANSWER_QUERY_TOOL] : [];
  const allTools = [...tools, ...busTools];
  const messages = [{ role: "user", content: userMessage }];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (state.analysisCancelled) throw new Error("분석 취소됨");

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools: allTools,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    const hasToolUse = response.content.some((b) => b.type === "tool_use");

    if (response.stop_reason === "end_turn" || !hasToolUse) {
      // end_turn 시에도 inbox 잔여 질의 처리
      if (bus) {
        const incoming = bus.drain(name);
        if (incoming.length > 0) {
          const queryText = incoming
            .map((q) => `[질의 ID:${q.id}] ${q.from} 에이전트 요청:\n${q.question}`)
            .join("\n\n");
          messages.push({
            role: "user",
            content: `다른 에이전트 질의가 도착했습니다:\n${queryText}\n\nanswer_query 도구로 각 질의에 답변해주세요.`,
          });
          continue;
        }
      }
      break;
    }

    const toolResults = [];
    let finished = false;

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (state.analysisCancelled) throw new Error("분석 취소됨");

      // ── send_finding ──
      if (block.name === "send_finding") {
        const { findingType, title, description, data } = block.input;
        findingMsg(name, label, findingType, title, description);
        _sharedFindings.push({ agent: name, label, findingType, title, description, data, ts: Date.now() });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: "finding received" }] });
        continue;
      }

      // ── write_report ──
      if (block.name === "write_report") {
        try {
          fs.mkdirSync(REPORT_DIR, { recursive: true });
          fs.writeFileSync(path.join(REPORT_DIR, `${name}.md`), block.input.content || "", "utf8");
          agentMsg(name, label, "progress", `리포트 저장: ${name}.md`);
        } catch (e) {
          agentMsg(name, label, "progress", `리포트 저장 실패: ${e.message}`);
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: "리포트 저장 완료" }] });
        continue;
      }

      // ── read_report (Lead 에이전트용) ──
      if (block.name === "read_report") {
        const fname = block.input.agent === "findings-summary"
          ? "findings-summary.md"
          : `${block.input.agent}.md`;
        const fpath = path.join(REPORT_DIR, fname);
        let content;
        try {
          content = fs.readFileSync(fpath, "utf8");
        } catch {
          content = `(${block.input.agent} 리포트 없음 — 해당 에이전트가 스킵되었거나 아직 작성 전입니다)`;
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: content }] });
        continue;
      }

      // ── report_findings ──
      if (block.name === "report_findings") {
        agentMsg(name, label, "done", "분析 완료");
        if (bus) {
          await bus.waitAndDrainUntilPredecessorsDone(name, label);
          bus.closeAgent(name, label);
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: "findings submitted" }] });
        messages.push({ role: "user", content: toolResults });
        finished = true;
        return block.input.findings || {};
      }

      // ── ask_agent: 다른 에이전트에게 질의 (응답 대기) ──
      if (block.name === "ask_agent" && bus) {
        const { target, question } = block.input;
        agentMsg(name, label, "progress", `→ [${target}] 질의: ${question.slice(0, 80)}`);
        try {
          const answer = await bus.ask(name, target, question);
          agentMsg(name, label, "progress", `← [${target}] 응답 수신`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: String(answer) }] });
        } catch (e) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: `오류: ${e.message}` }], is_error: true });
        }
        continue;
      }

      // ── answer_query: 수신된 질의에 답변 ──
      if (block.name === "answer_query" && bus) {
        const { query_id, answer } = block.input;
        bus.reply(query_id, answer);
        agentMsg(name, label, "progress", `↩ 질의 ${query_id} 답변 전송`);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: "답변 전송됨" }] });
        continue;
      }

      // ── 일반 도구 실행 ──
      agentMsg(name, label, "progress", block.name);
      let result;
      try {
        result = execTool ? await execTool(block.name, block.input) : { error: "도구 없음" };
      } catch (err) {
        result = { error: err.message };
      }

      let content;
      if (block.name === "browser_screenshot" && result.image) {
        content = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: result.image } }];
      } else {
        content = [{ type: "text", text: JSON.stringify(result).slice(0, 10000) }];
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
    }

    if (finished) break;

    // 도구 결과 전송 + inbox 잔여 질의 병합
    const userContent = [...toolResults];
    if (bus) {
      const incoming = bus.drain(name);
      if (incoming.length > 0) {
        const queryText = incoming
          .map((q) => `[질의 ID:${q.id}] ${q.from} 에이전트 요청:\n${q.question}`)
          .join("\n\n");
        userContent.push({
          type: "text",
          text: `\n\n다른 에이전트 질의:\n${queryText}\n\nanswer_query 도구로 각 질의에 답변해주세요.`,
        });
      }
    }
    messages.push({ role: "user", content: userContent });
  }

  agentMsg(name, label, "done", "완료");
  if (bus) {
    await bus.waitAndDrainUntilPredecessorsDone(name, label);
    bus.closeAgent(name, label);
  }
  return {};
}

// ════════════════════════════════════════════════════════════════════════════
// 에이전트 팀
// ════════════════════════════════════════════════════════════════════════════

// ── 1. UI 에이전트 ───────────────────────────────────────────────────────────
async function runUIAgent(url, pageSource, bus) {
  return runAgent({
    name: "ui", label: "UI 분석",
    bus,
    tools: [
      {
        name: "browser_get_page_info",
        description: "현재 페이지의 입력 요소, 버튼, URL, 제목을 반환합니다.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "browser_screenshot",
        description: "현재 화면 스크린샷",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      SEND_FINDING_TOOL,
      WRITE_REPORT_TOOL,
      REPORT_TOOL,
    ],
    systemPrompt: `당신은 웹 UI 분석 에이전트입니다.
현재 페이지의 UI 구조를 분석하여 비즈니스 로직을 파악합니다.

분석 방법:
1. browser_get_page_info로 입력 요소/버튼 목록 수집
2. browser_screenshot으로 화면 확인
3. 발견사항마다 send_finding 호출 (폼 필드, 버튼 역할, 화면 목적 등)

에이전트 협업 (ask_agent 도구 활용):
- 조회 화면에서 실제 조회 조건 데이터가 필요하면 DB 에이전트에게 요청하세요.
  예: ask_agent("db", "주문 목록 조회 화면의 테스트 데이터가 필요합니다. 조회 조건: 날짜범위, 상태코드. 유효한 샘플 값을 제공해주세요.")
- DB 에이전트가 응답하면 그 데이터를 send_finding에 포함하고 실제 조회 가능한 케이스에 활용하세요.
- 다른 에이전트로부터 질의가 도착하면 answer_query로 답변하세요.


테스트 데이터 확인 (write_report 전 필수):
소스/화면 분析이 완료되면, 발견한 테스트 시나리오별 검증에 필요한 실제 데이터를 DB 에이전트에게 요청하세요:
  ask_agent("db", "다음 테스트 케이스 검증을 위한 실제 데이터를 조회해주세요:\n[시나리오명]: [필요한 조건값/ID/코드값 설명]")
DB 에이전트 응답 데이터를 리포트 '## 테스트 케이스별 필요 데이터' 섹션에 반드시 포함하세요.
(DB 미설정이거나 응답 없으면 '(DB 데이터 미확인)'으로 표기)
분석 완료 후 순서:
1. write_report 도구로 마크다운 리포트 작성 (형식 예시):
   # UI 분석 리포트
   ## 페이지 개요
   ## 화면 구성 요소 (폼 필드, 버튼 등)
   ## 사용자 액션
   ## 테스트 데이터 (DB 에이전트 응답 포함)
   ## 테스트 관점 메모
   ## 테스트 케이스별 필요 데이터 (DB 에이전트 응답)
2. report_findings 도구로 구조화 JSON 제출:
   - pageTitle, purpose, formFields, buttons, sections, userActions, testData`,
    userMessage: `현재 URL: ${url}

현재 페이지 HTML (일부):
\`\`\`html
${pageSource.slice(0, 6000)}
\`\`\`

UI를 분석하여 발견사항을 send_finding으로 전달하고, 완료 후 report_findings를 호출하세요.`,
    execTool: async (name, input) => {
      if (name === "browser_get_page_info") {
        return state.activePage.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll("input,textarea,select,button"))
            .slice(0, 40).map((el) => ({
              tag: el.tagName.toLowerCase(), type: el.type || null,
              id: el.id || null, name: el.name || null,
              placeholder: el.placeholder || null,
              text: (el.innerText || el.textContent || "").trim().slice(0, 80),
              visible: el.getBoundingClientRect().width > 0,
            }));
          return { url: location.href, title: document.title, inputs };
        });
      }
      return execBrowser(name, input);
    },
  });
}
// ─────────────────────────────────────────────────
// 페이지 origin 다음 첫 path 세그먼트를 GitLab 프로젝트로 삼아 3-level chain
// (UI 프로젝트 → 중간 static-spring 프로젝트 → backend 프로젝트) 을 따라간다.
//
// 각 레벨에서 source 를 읽어 다음 레벨의 API 엔드포인트를 추출한다.
// 한 레벨에 여러 엔드포인트가 있으면 각각의 프로젝트를 병렬로 따라가도록
// 에이전트에게 지시한다 (실제 LLM 의 도구 호출은 직렬이지만 모든 엔드포인트를
// 검사하도록 강제).
async function runUISourceAgent(url, bus) {
  if (!gitlab.isReady()) {
    agentMsg("ui-source", "UI 소스 분석", "done", "GitLab 미설정 — 스킵");
    if (bus) bus.closeAgent("ui-source", "UI 소스 분析");
    return { skipped: true, levels: [], apiEndpoints: [] };
  }

  const uiProject = projectFromUrl(url);
  if (!uiProject) {
    agentMsg("ui-source", "UI 소스 분석", "done", "URL에서 프로젝트 도출 실패 — 스킵");
    if (bus) bus.closeAgent("ui-source", "UI 소스 분析");
    return { skipped: true, levels: [], apiEndpoints: [] };
  }

  const uiBranch = branchFor(uiProject);
  const urlPath  = (() => { try { return new URL(url).pathname; } catch { return url; } })();

  agentMsg(
    "ui-source", "UI 소스 분석", "progress",
    `프로젝트=${uiProject}, 브랜치=${uiBranch}, 경로=${urlPath}`,
  );

  return runAgent({
    name: "ui-source", label: "UI 소스 분석",
    bus,
    tools: [...GITLAB_IN_TOOLS, SEND_FINDING_TOOL, WRITE_REPORT_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 3-tier 웹 시스템의 소스코드를 가로지르며 분석하는 에이전트입니다.

목표:
- 현재 화면(UI)에서 호출되는 API 를 따라 중간 계층(Static Spring/BFF)과
  최종 백엔드 계층까지 소스를 추적하여 비즈니스 로직을 파악한다.

용어:
- "프로젝트"는 URL 의 origin 다음 첫 path 세그먼트.
  예: https://app.example.com/order/list  → 프로젝트 = "order"
       /payment/charge                     → 프로젝트 = "payment"
- "브랜치"는 get_branch_for_project 도구로 조회 (CLAUDE.md 매핑표 기반).

분석 절차 (3 levels):

[Level 0 — UI Vue 프로젝트]
프로젝트="${uiProject}", 브랜치="${uiBranch}", 현재 경로="${urlPath}"
1. gitlab_list_files_in 으로 루트 구조 파악
2. gitlab_search_code_in 으로 Vue Router 에서 "${urlPath}" 매칭되는 라우트 검색
3. 매핑된 .vue 컴포넌트와 import 한 API 클라이언트(src/api/, src/services/) 읽기
4. 호출되는 API 엔드포인트 추출 → send_finding(findingType: "api_endpoint",
   description 에 method/path/요청파라미터 포함)

[Level 1 — 중간 계층 (Static Spring / BFF)]
각 L0 엔드포인트에 대해 *모두* 다음을 수행 (병렬 의미 = 빠뜨리지 말 것):
1. derive_project_from_url 로 엔드포인트 경로에서 프로젝트명 도출
2. get_branch_for_project 로 브랜치 조회
3. gitlab_search_code_in 으로 해당 핸들러(@GetMapping/@PostMapping 등) 검색
4. 핸들러가 호출하는 다음 단계 API (RestTemplate/WebClient/Feign 등) 추출
5. 발견되는 모든 엔드포인트 → send_finding(findingType: "api_endpoint")

[Level 2 — 백엔드 계층]
각 L1 엔드포인트에 대해 *모두* 동일하게:
1. derive_project_from_url → 프로젝트 도출
2. get_branch_for_project → 브랜치
3. 컨트롤러 → 서비스 → 매퍼/리포지토리 추적
4. 비즈니스 로직 / DB 테이블 / 권한 / 에러 시나리오 → send_finding 으로 적시 전달


테스트 데이터 확인 (write_report 전 필수):
소스/화면 분析이 완료되면, 발견한 테스트 시나리오별 검증에 필요한 실제 데이터를 DB 에이전트에게 요청하세요:
  ask_agent("db", "다음 테스트 케이스 검증을 위한 실제 데이터를 조회해주세요:\n[시나리오명]: [필요한 조건값/ID/코드값 설명]")
DB 에이전트 응답 데이터를 리포트 '## 테스트 케이스별 필요 데이터' 섹션에 반드시 포함하세요.
(DB 미설정이거나 응답 없으면 '(DB 데이터 미확인)'으로 표기)
종료:
1. write_report 도구로 마크다운 리포트 작성:
   # UI 소스 분석 리포트
   ## Level 0: UI 프로젝트 (컴포넌트, API 클라이언트)
   ## Level 1: 중간 계층 (BFF/Static-Spring, 엔드포인트)
   ## Level 2: 백엔드 계층 (컨트롤러, 서비스, DB 테이블)
   ## 전체 API 엔드포인트 목록
   ## 비즈니스 로직 요약
   ## 테스트 케이스별 필요 데이터 (DB 에이전트 응답)
2. report_findings 호출. findings 포함 내용:
   {
     levels: [
       { level: 0, project, branch, files, apiEndpoints: [{method, path}] },
       { level: 1, projects: [{project, branch, files, apiEndpoints}] },
       { level: 2, projects: [{project, branch, files, businessLogic, dbTables}] }
     ],
     apiEndpoints: [...],
   }`,
    userMessage: `시작 URL: ${url}
시작 프로젝트: ${uiProject}
시작 브랜치: ${uiBranch}
현재 경로: ${urlPath}

위 systemPrompt 의 Level 0 → 1 → 2 절차를 따라 분석한 뒤 send_finding 으로
중간 발견을 적시 전달하고, 모든 레벨이 끝나면 report_findings 를 호출하세요.`,
    execTool: execGitlab,
    maxTurns: 60,
  });
}

// ── 2. Frontend 에이전트 ──────────────────────────────────────────────────────
async function runFrontendAgent(url, bus) {
  if (!gitlab.isConfigured()) {
    agentMsg("frontend", "Frontend 분석", "done", "GitLab 미설정 — 스킵");
    if (bus) bus.closeAgent("frontend", "Frontend 분析");
    return { skipped: true, apiEndpoints: [], validationRules: [] };
  }
  const urlPath    = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  const projectIds = gitlab.getProjectIds();

  return runAgent({
    name: "frontend", label: "Frontend 분석",
    bus,
    tools: [...GITLAB_TOOLS, ...GITLAB_IN_TOOLS, SEND_FINDING_TOOL, WRITE_REPORT_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 Vue.js 프론트엔드 소스 분석 에이전트입니다.
현재 URL 경로에 해당하는 Vue 컴포넌트를 추적하여 UI→API까지 분석합니다.

## 프로젝트 탐색 전략

설정된 GitLab 프로젝트 IDs: [${projectIds.join(", ")}]
이 목록의 모든 프로젝트를 순서대로 검색하여 프론트엔드 소스를 찾으세요.

탐색 방법:
- gitlab_search_code_in(projectId, "검색어") 로 각 프로젝트 검색
- gitlab_list_files_in(projectId, "") 로 루트 구조 확인
- gitlab_get_file_in(projectId, "파일경로") 로 파일 읽기
- 첫 번째 프로젝트에서 결과가 없으면 다음 프로젝트로 전환

분석 순서:
1. 각 프로젝트에서 gitlab_search_code_in 으로 Vue Router에서 현재 경로("${urlPath}") 검색
2. 매핑된 Vue 컴포넌트 파일 읽기 (gitlab_get_file_in)
3. 컴포넌트의 import 문 추적:
   - 하위 컴포넌트 (src/components/ 등)
   - Composables / hooks (src/composables/)
   - API 클라이언트 파일 (src/api/, src/services/)
4. API 클라이언트에서 엔드포인트 경로 추출

비즈니스 로직 발견 시 즉시 send_finding 호출:
- API 엔드포인트 발견 → findingType: "api_endpoint"
- 유효성 검증 규칙 발견 → findingType: "validation_rule"
- 비즈니스 로직 발견 → findingType: "business_logic"

에이전트 협업: 다른 에이전트로부터 질의가 도착하면 answer_query로 답변하세요.


테스트 데이터 확인 (write_report 전 필수):
소스/화면 분析이 완료되면, 발견한 테스트 시나리오별 검증에 필요한 실제 데이터를 DB 에이전트에게 요청하세요:
  ask_agent("db", "다음 테스트 케이스 검증을 위한 실제 데이터를 조회해주세요:\n[시나리오명]: [필요한 조건값/ID/코드값 설명]")
DB 에이전트 응답 데이터를 리포트 '## 테스트 케이스별 필요 데이터' 섹션에 반드시 포함하세요.
(DB 미설정이거나 응답 없으면 '(DB 데이터 미확인)'으로 표기)
분석 완료 후 순서:
1. write_report 도구로 마크다운 리포트 작성:
   # Frontend 분석 리포트
   ## 라우터 → 컴포넌트 매핑
   ## API 엔드포인트 목록
   ## 유효성 검증 규칙
   ## 폼 필드 목록
   ## 비즈니스 로직
   ## 테스트 케이스별 필요 데이터 (DB 에이전트 응답)
2. report_findings 도구로 구조화 JSON 제출:
   - routerFile, componentFile, componentFiles, apiEndpoints, validationRules, formFields, businessLogic`,
    userMessage: `현재 페이지 URL: ${url} (경로: ${urlPath})
탐색할 프로젝트 IDs: [${projectIds.join(", ")}]

각 프로젝트에서 Vue Router → 컴포넌트 → API 클라이언트 순으로 추적하고,
발견사항을 send_finding으로 전달한 뒤 write_report → report_findings 순으로 완료하세요.`,
    execTool: execGitlab,
  });
}

// ── 3. Backend 에이전트 ───────────────────────────────────────────────────────
async function runBackendAgent(frontendFindings, bus, url) {
  if (!gitlab.isConfigured()) {
    agentMsg("backend", "Backend 분석", "done", "GitLab 미설정 — 스킵");
    if (bus) bus.closeAgent("backend", "Backend 분析");
    return { skipped: true, businessLogic: [], dbTables: [], authRules: [] };
  }
  const endpoints  = frontendFindings.apiEndpoints || [];
  const projectIds = gitlab.getProjectIds();
  // 팀 모드(bus 있음): 엔드포인트 없어도 URL로 시작, 질의 응답 대기
  // 단독 모드(bus 없음): 엔드포인트 없으면 스킵
  if (!bus && !endpoints.length) {
    agentMsg("backend", "Backend 분석", "done", "API 엔드포인트 없음 — 스킵");
    return { skipped: true, businessLogic: [], dbTables: [], authRules: [] };
  }

  const projectsNote = `탐색할 프로젝트 IDs: [${projectIds.join(", ")}]
각 프로젝트를 순서대로 검색하여 관련 소스를 찾으세요. 한 프로젝트에서 결과가 없으면 다음 프로젝트로 전환하세요.`;

  const userMessage = endpoints.length
    ? `Frontend 분석 결과 (API 엔드포인트):
\`\`\`json
${JSON.stringify({ apiEndpoints: endpoints, validationRules: frontendFindings.validationRules || [] }, null, 2).slice(0, 4000)}
\`\`\`

${projectsNote}

각 엔드포인트의 백엔드 컨트롤러/서비스를 찾아 분석하고,
발견사항을 send_finding으로 전달하면서 report_findings를 호출하세요.`
    : `분석 대상 URL: ${url || "알 수 없음"}

${projectsNote}

Frontend 에이전트가 아직 엔드포인트를 제공하지 않았습니다.
URL 경로를 기반으로 직접 백엔드 소스를 탐색하거나,
다른 에이전트의 질의(answer_query)에 응답하면서 report_findings를 호출하세요.`;

  return runAgent({
    name: "backend", label: "Backend 분석",
    bus,
    tools: [...GITLAB_IN_TOOLS, SEND_FINDING_TOOL, WRITE_REPORT_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 백엔드 소스 분석 에이전트입니다.
프론트엔드 에이전트가 발견한 API 엔드포인트를 바탕으로 백엔드 컨트롤러/서비스를 분석합니다.

## 프로젝트 탐색 전략

설정된 GitLab 프로젝트 IDs: [${projectIds.join(", ")}]
이 목록의 모든 프로젝트를 순서대로 검색하여 백엔드 소스를 찾으세요.

탐색 방법 (gitlab_*_in 도구 사용):
- gitlab_search_code_in(projectId, "검색어") — 각 프로젝트에서 코드 검색
- gitlab_list_files_in(projectId, "") — 루트 구조 확인
- gitlab_get_file_in(projectId, "파일경로") — 파일 읽기

탐색 순서:
1. 각 API 엔드포인트 경로로 모든 프로젝트에서 순서대로 검색
   (Spring: "@GetMapping/@PostMapping", Node: "router.get/router.post")
   - 결과 없으면 다음 프로젝트 ID로 전환, 포기하지 마세요
2. 소스 발견 시: 컨트롤러 → 서비스 → 리포지터리/매퍼 순서로 추적
3. 각 파일의 import/의존성을 따라가며 계속 탐색
4. DB 쿼리, 테이블명, 비즈니스 조건 파악

발견 시 즉시 send_finding 호출:
- DB 테이블 → findingType: "db_table"
- 권한/인증 규칙 → findingType: "auth_rule"
- 에러 시나리오 → findingType: "error_scenario"
- 비즈니스 로직 → findingType: "business_logic"

에이전트 협업 (팀 모드):
- DB 에이전트나 UI 에이전트로부터 질의가 도착하면 answer_query로 즉시 답변하세요.
  예: DB 에이전트가 "주문 테이블의 상태코드 컬럼명을 알려주세요" 질의 → 소스 확인 후 답변
- Frontend 에이전트에게 ask_agent로 엔드포인트 정보를 요청할 수도 있습니다.


테스트 데이터 확인 (write_report 전 필수):
소스/화면 분析이 완료되면, 발견한 테스트 시나리오별 검증에 필요한 실제 데이터를 DB 에이전트에게 요청하세요:
  ask_agent("db", "다음 테스트 케이스 검증을 위한 실제 데이터를 조회해주세요:\n[시나리오명]: [필요한 조건값/ID/코드값 설명]")
DB 에이전트 응답 데이터를 리포트 '## 테스트 케이스별 필요 데이터' 섹션에 반드시 포함하세요.
(DB 미설정이거나 응답 없으면 '(DB 데이터 미확인)'으로 표기)
분석 완료 후 순서:
1. write_report 도구로 마크다운 리포트 작성:
   # Backend 분석 리포트
   ## 분석 대상 엔드포인트
   ## 컨트롤러 → 서비스 → 리포지터리 추적 결과
   ## DB 테이블 및 주요 컬럼
   ## 비즈니스 로직 (조건, 분기, 에러 처리)
   ## 권한/인증 규칙
   ## 테스트 시나리오 제안
   ## 테스트 케이스별 필요 데이터 (DB 에이전트 응답)
2. report_findings 도구로 구조화 JSON 제출:
   - controllerFiles, businessLogic, dbTables, authRules, errorScenarios, testScenarios`,
    userMessage,
    execTool: execGitlab,
  });
}

// ── 4. DB 에이전트 ────────────────────────────────────────────────────────────
async function runDBAgent(frontendFindings, backendFindings, bus, url) {
  const configuredDbs = db.configuredDbs();
  if (!configuredDbs.length) {
    agentMsg("db", "DB 분석", "done", "DB 미설정 — 스킵");
    if (bus) bus.closeAgent("db", "DB 분析");
    return { skipped: true, testData: {}, validIds: {} };
  }

  const dbTables = backendFindings.dbTables || [];
  const entityHints = (frontendFindings.apiEndpoints || []).map((e) => e.path).join(", ");

  const userMessage = dbTables.length
    ? `Backend 분석 결과 (사용 테이블):
\`\`\`json
${JSON.stringify(dbTables, null, 2).slice(0, 3000)}
\`\`\`

API 경로 힌트: ${entityHints}
설정된 DB: ${configuredDbs.join(", ")}

테스트 데이터를 조회하고 report_findings를 호출하세요.`
    : `분석 대상 URL: ${url || "알 수 없음"}
설정된 DB: ${configuredDbs.join(", ")}

Backend 에이전트가 아직 테이블 정보를 제공하지 않았습니다.
ask_agent("backend", "...")로 관련 DB 테이블과 쿼리 정보를 문의하세요.
또한 UI 에이전트로부터 조회 조건 데이터 요청이 오면 answer_query로 응답하세요.
필요한 정보를 수집한 후 테스트 데이터를 조회하고 report_findings를 호출하세요.`;

  return runAgent({
    name: "db", label: "DB 분석",
    bus,
    tools: [...buildDbTools(configuredDbs), SEND_FINDING_TOOL, WRITE_REPORT_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 DB 데이터 분석 에이전트입니다.
테스트에 사용할 실제 데이터를 DB에서 조회합니다.

DB 용도:
- center DB: 공통코드, 권한, 마스터 데이터 (조직코드, 분류코드 등)
- local DB: 업무/도메인 데이터 (사용자, 계정, 거래, 업무 데이터 등)

조회 전략:
1. 백엔드에서 사용하는 테이블에서 샘플 데이터 SELECT (LIMIT 5)
2. 테스트에 필요한 유효한 ID/코드값 확보
3. 경계값 데이터 확인 (빈 결과, 최대값 등)
4. 설정된 DB가 여러 개면 모두 조회

에이전트 협업 (팀 모드) — 핵심 역할:
- UI, UISource, Frontend, Backend 에이전트가 테스트 케이스 검증 데이터를 요청합니다.
  요청이 도착하면 반드시 실제 db_query를 실행하여 결과를 answer_query로 전달하세요.
  (자동응답/빈 응답 금지. 모르는 테이블이면 먼저 ask_agent("backend", ...)로 테이블명 확인)
  예: "주문 조회 테스트 데이터 요청" → db_query로 ORDER 테이블 샘플 SELECT → answer_query로 결과 전달
- 각 에이전트 질의에 우선 응답한 후 자신의 분析도 완료하세요.
- 루프 동안 answer_query 처리를 여러 번 수행할 수 있습니다. 모든 질의에 응답하세요.

데이터 발견 시 send_finding 호출 (findingType: "db_table")

분析 완료 후 순서:
1. write_report 도구로 마크다운 리포트 작성:
   # DB 분析 리포트
   ## 조회한 테이블 목록
   ## 샘플 데이터 (테이블별)
   ## 유효 ID/코드 목록 (테스트에 사용 가능한 값)
   ## 경계값 데이터 (빈 결과, 최대값 등)
   ## 에이전트별 테스트 데이터 요청 처리 내역 (어느 에이전트에게 어떤 데이터를 제공했는지)
   ## 테스트 데이터 활용 가이드
2. report_findings 도구로 구조화 JSON 제출:
   - testData, validIds, agentDataProvided, summary`,
    userMessage,
    execTool: execDb,
  });
}

// ── 에이전트 팀 — Phase 1+2 병렬 실행 + 실시간 에이전트 간 통신 ─────────────────
async function runAgentTeam(url, pageSource) {
  const bus = new AgentBus();
  ["ui", "ui-source", "frontend", "backend", "db"].forEach((n) => bus.register(n));

  phaseMsg(1, 2, "에이전트 팀 병렬 분석 (UI · 소스 · Frontend · Backend · DB)");

  const settled = await Promise.allSettled([
    runUIAgent(url, pageSource, bus)
      .catch((e) => { agentMsg("ui",        "UI 분석",        "error", e.message); bus.closeAgent("ui",        "UI 분석");        return {}; }),
    runUISourceAgent(url, bus)
      .catch((e) => { agentMsg("ui-source", "UI 소스 분석",   "error", e.message); bus.closeAgent("ui-source", "UI 소스 분석");   return {}; }),
    runFrontendAgent(url, bus)
      .catch((e) => { agentMsg("frontend",  "Frontend 분석",  "error", e.message); bus.closeAgent("frontend",  "Frontend 분석");  return {}; }),
    runBackendAgent({ apiEndpoints: [] }, bus, url)
      .catch((e) => { agentMsg("backend",   "Backend 분석",   "error", e.message); bus.closeAgent("backend",   "Backend 분석");   return {}; }),
    runDBAgent({ apiEndpoints: [] }, { dbTables: [] }, bus, url)
      .catch((e) => { agentMsg("db",        "DB 분석",        "error", e.message); bus.closeAgent("db",        "DB 분석");        return {}; }),
  ]);

  const [uiF, uiSourceF, frontendF, backendF, dbF] = settled.map((r) =>
    r.status === "fulfilled" ? (r.value || {}) : {}
  );

  // UISource에서 찾은 apiEndpoints를 Frontend 결과에 병합
  if (uiSourceF?.apiEndpoints?.length) {
    frontendF.apiEndpoints = [
      ...(frontendF.apiEndpoints || []),
      ...uiSourceF.apiEndpoints,
    ];
  }

  return { uiF, uiSourceF, frontendF, backendF, dbF };
}

// ── Lead 에이전트 — 리포트 파일 읽기 → 테스트케이스 도출 ──────────────────────
async function runLeadAgent(url) {
  // 실시간 발견 목록을 findings-summary.md로 사전 저장
  const findingsSummary = _sharedFindings
    .map((f) => `- [${f.label}] **${f.findingType}**: ${f.title}${f.description ? " — " + f.description : ""}`)
    .join("\n");
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(REPORT_DIR, "findings-summary.md"),
      `# 에이전트 실시간 발견 목록\n\n${findingsSummary || "(없음)"}`,
      "utf8",
    );
  } catch {}

  const leadResult = await runAgent({
    name: "lead", label: "리드 에이전트",
    tools: [READ_REPORT_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 QA 리드 에이전트입니다.
각 분석 에이전트가 작성한 마크다운 리포트를 읽고 종합하여 실행 가능한 테스트 케이스를 도출합니다.

분석 순서:
1. read_report로 모든 리포트를 읽으세요 (순서 권장):
   - "findings-summary" : 모든 에이전트의 실시간 발견 목록
   - "ui"               : UI/화면 구조 분석 결과
   - "ui-source"        : 3-tier 소스 체인 (UI→BFF→Backend) 분석 결과
   - "frontend"         : Vue 컴포넌트·API 클라이언트 분석 결과
   - "backend"          : 백엔드 컨트롤러·서비스·DB 테이블 분석 결과
   - "db"               : 테스트 데이터 조회 결과
2. 읽은 내용을 종합하여 테스트 케이스를 도출하세요.
3. report_findings({ findings: { testCases: [...] } })로 최종 결과를 제출하세요.

테스트 케이스 형식 (findings.testCases 배열 원소):
{
  "name": "[화면명] - [시나리오]",
  "steps": [{"action": "navigate|click|type|key|scroll|screenshot", "selector"?: "...", "text"?: "...", "url"?: "...", "key"?: "..."}],
  "testData": {},
  "expectedResult": "..."
}

포함할 케이스 유형:
1. 정상 경로 (Happy path) — 유효 데이터로 성공
2. 유효성 오류 — 필수값 누락, 형식 오류
3. 권한/인증 경계 (해당하는 경우)
4. 경계값 — 빈 목록, 최대값

리포트가 없는 에이전트(스킵된 경우)는 무시하고, 확인된 정보만으로 반드시 테스트케이스를 도출하세요.`,
    userMessage: `분석 URL: ${url}

read_report 도구로 각 에이전트 리포트를 읽고, 모든 리포트 확인 후 report_findings로 테스트케이스를 제출하세요.`,
    execTool: async (toolName, input) => {
      if (toolName === "read_report") {
        const fname = input.agent === "findings-summary"
          ? "findings-summary.md"
          : `${input.agent}.md`;
        try {
          return { content: fs.readFileSync(path.join(REPORT_DIR, fname), "utf8") };
        } catch {
          return { content: `(${input.agent} 리포트 없음 — 해당 에이전트가 스킵되었거나 리포트 미작성)` };
        }
      }
      return { error: `알 수 없는 도구: ${toolName}` };
    },
    maxTurns: 20,
  });

  const testCases = (leadResult.testCases) || [];
  agentMsg("lead", "리드 에이전트", "done", `테스트 케이스 ${testCases.length}개 도출 완료`);
  send({ type: "analyze-synthesis", testCases: testCases.map((tc) => ({ name: tc.name, expectedResult: tc.expectedResult })) });
  return testCases;
}

// ── 6. Recording 에이전트 ─────────────────────────────────────────────────────
async function runRecordingAgent(tc, index, total) {
  send({ type: "analyze-recording", name: tc.name, index: index + 1, total });
  agentMsg("recording", `레코딩 ${index + 1}/${total}`, "start", tc.name);
  startRecording(tc.name);

  await runAgent({
    name: "recording",
    label: `레코딩 ${index + 1}/${total}`,
    tools: [...BROWSER_TOOLS, REPORT_TOOL],
    systemPrompt: `당신은 테스트 케이스를 브라우저에서 직접 실행하는 레코딩 에이전트입니다.
주어진 단계를 순서대로 실행하세요.
각 주요 액션 전후에 browser_screenshot으로 진행 상황을 확인하세요.
완료되면 report_findings({ "completed": true, "summary": "간략 결과" })를 호출하세요.`,
    userMessage: `테스트 케이스 [${index + 1}/${total}]: ${tc.name}

예상 결과: ${tc.expectedResult || ""}

실행 단계:
${JSON.stringify(tc.steps, null, 2)}

사용할 테스트 데이터:
${JSON.stringify(tc.testData || {}, null, 2)}

단계를 순서대로 실행하세요.`,
    execTool: execBrowser,
    maxTurns: 30,
  });

  const id = await stopRecording();
  if (id) {
    log("success", `[레코딩] 저장: ${tc.name} (id=${id})`);
    send({ type: "recordings", list: dbAllMeta() });
    agentMsg("recording", `레코딩 ${index + 1}/${total}`, "done", `저장 완료 (id=${id})`);
    return id;
  }
  log("warn", `[레코딩] 이벤트 없음 — 미저장: ${tc.name}`);
  agentMsg("recording", `레코딩 ${index + 1}/${total}`, "done", "이벤트 없음 (미저장)");
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// 메인 오케스트레이터
// ════════════════════════════════════════════════════════════════════════════

async function runAnalysis(url) {
  if (state.isAnalyzing) {
    send({ type: "analyze-error", message: "이미 분석이 진행 중입니다." });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    send({ type: "analyze-error", message: "ANTHROPIC_API_KEY가 설정되지 않았습니다." });
    return;
  }

  state.isAnalyzing      = true;
  state.analysisCancelled = false;
  resetFindings();

  let createdCount = 0;
  send({ type: "analyze-started", url });
  log("info", `━━ 분석 시작: ${url} ━━`);

  try {
    // 현재 페이지 DOM 수집
    let pageSource = "";
    try { pageSource = await state.activePage.evaluate(() => document.documentElement.outerHTML); } catch {}

    // ── Phase 1: 에이전트 팀 병렬 분석 (UI · 소스 · Frontend · Backend · DB) ──
    const { uiF, uiSourceF, frontendF, backendF, dbF } = await runAgentTeam(url, pageSource);

    if (state.analysisCancelled) throw new Error("취소됨");

    // ── Phase 2: Lead 에이전트 취합 → 테스트 케이스 도출 → 레코딩 ─────────────
    phaseMsg(2, 2, "테스트 케이스 도출 → 레코딩");
    const testCases = await runLeadAgent(url);

    for (let i = 0; i < testCases.length; i++) {
      if (state.analysisCancelled) break;
      const id = await runRecordingAgent(testCases[i], i, testCases.length)
        .catch((e) => { agentMsg("recording", `레코딩 ${i + 1}`, "error", e.message); return null; });
      if (id) createdCount++;
    }

    if (_recHandler) {
      const id = await stopRecording();
      if (id) { createdCount++; send({ type: "recordings", list: dbAllMeta() }); }
    }

  } catch (err) {
    log("fail", `[분석] 오류: ${err.message}`);
    send({ type: "analyze-error", message: err.message });
  } finally {
    state.isAnalyzing = false;
    log(createdCount > 0 ? "success" : "warn", `━━ 분석 완료: ${createdCount}개 테스트 케이스 생성 ━━`);
    send({ type: "analyze-done", created: createdCount });
  }
}

module.exports = { runAnalysis };
