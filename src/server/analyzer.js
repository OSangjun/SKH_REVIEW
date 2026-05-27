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

  // DB별 엔진 정보를 도구 설명에 포함
  const dbDesc = configuredDbs.map((n) => {
    const eng = db.engineFor(n);
    const syntax = eng === "tibero"
      ? "Tibero — 행 제한: FETCH FIRST N ROWS ONLY 또는 ROWNUM <= N"
      : eng === "mariadb"
      ? "MariaDB — 행 제한: LIMIT N"
      : eng === "pg"
      ? "PostgreSQL — 행 제한: LIMIT N"
      : n;
    return `- ${n}: ${syntax}`;
  }).join("\n");

  return [{
    name: "db_query",
    description: [
      "DB에 SELECT 쿼리를 실행합니다. db 파라미터로 접속할 DB를 지정하세요.",
      "⚠️ 모든 SELECT는 시스템이 자동으로 최대 100건으로 제한합니다.",
      "",
      "DB 종류 및 엔진별 문법:",
      "- local: 업무/도메인 데이터 (사용자, 거래, 계정 등)",
      "- center: 공통/마스터 데이터 (공통코드, 권한, 기준 데이터 등)",
      "",
      "설정된 DB 및 엔진:",
      dbDesc,
      "",
      "Tibero 쿼리 예시 (FETCH FIRST 사용 권장):",
      "  SELECT col1, col2 FROM table_name WHERE cond = :1 FETCH FIRST 10 ROWS ONLY",
      "MariaDB 쿼리 예시:",
      "  SELECT col1, col2 FROM table_name WHERE cond = ? LIMIT 10",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        sql:    { type: "string", description: "실행할 SELECT SQL (엔진에 맞는 문법 사용)" },
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

// SELECT 쿼리에 LIMIT 100 을 강제 적용한다 (엔진별 문법 분기).
// db-client.js 의 enforceSqlLimitForEngine 와 동일 로직 — analyzer 1차 방어선.
//   mariadb : LIMIT N
//   tibero  : FETCH FIRST N ROWS ONLY  /  ROWNUM <= N
function enforceSqlLimit(sql, dbName, maxRows = 100) {
  const engine = db.engineFor(dbName) || "mariadb";
  sql = sql.replace(/;\s*$/, "").trim();

  if (engine === "tibero") {
    if (/\bFETCH\s+FIRST\s+\d+\s+ROWS?\s+ONLY\b/i.test(sql)) {
      return sql.replace(
        /\bFETCH\s+FIRST\s+(\d+)\s+(ROWS?\s+ONLY)\b/gi,
        (_, n, rest) => `FETCH FIRST ${Math.min(parseInt(n, 10), maxRows)} ${rest}`,
      );
    }
    if (/\bROWNUM\s*<[=]?\s*\d+/i.test(sql)) {
      return sql.replace(
        /\bROWNUM\s*(<[=]?)\s*(\d+)/gi,
        (_, op, n) => `ROWNUM ${op} ${Math.min(parseInt(n, 10), maxRows)}`,
      );
    }
    return `${sql} FETCH FIRST ${maxRows} ROWS ONLY`;
  }

  // mariadb / pg
  if (!/\bLIMIT\b/i.test(sql)) return `${sql} LIMIT ${maxRows}`;
  return sql.replace(/\bLIMIT\s+(\d+)(?:\s*,\s*(\d+))?/gi, (_, n1, n2) => {
    if (n2 !== undefined) return `LIMIT ${n1}, ${Math.min(parseInt(n2, 10), maxRows)}`;
    return `LIMIT ${Math.min(parseInt(n1, 10), maxRows)}`;
  });
}

async function execDb(name, input) {
  if (name !== "db_query") return { error: `알 수 없는 도구: ${name}` };
  const raw    = (input.sql || "").trim();
  if (!/^select/i.test(raw)) return { error: "SELECT 쿼리만 허용됩니다." };
  const dbName = input.db || "local";
  const sql    = enforceSqlLimit(raw, dbName);   // 엔진별 LIMIT 100 보장
  const rows   = await db.query(sql, input.params || [], dbName);
  return { rows, count: rows.length, db: dbName, appliedSql: sql };
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

function agentMsg(agent, label, status, message, meta = {}) {
  send({ type: "analyze-agent", agent, label, status, message, ...meta });
  const lvl = status === "error" ? "fail" : status === "done" ? "success" : "info";
  log(lvl, `[${label}] ${message}`);
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
    this._inbox     = {};        // agentName → Array<{id, from, question}>
    this._pending   = new Map(); // queryId → {resolve, reject}
    this._queryFrom = new Map(); // queryId → from (answer_query 시 발신자 추적용)
    this._seq       = 0;
    this._closed    = new Map(); // agentName → label (종료된 에이전트 추적)
  }
  register(name) { this._inbox[name] = []; }

  ask(from, to, question, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      // 대상 에이전트가 이미 종료된 경우 즉시 응답 (90초 대기 없음)
      if (this._closed.has(to)) {
        const label = this._closed.get(to);
        agentMsg(from, from, "progress", `↩ [즉시] ${to} 에이전트 이미 종료 — 자동 응답`, { toAgent: to, msgDir: "to" });
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
      this._queryFrom.set(id, from);
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
  queryFrom(id) { return this._queryFrom.get(id) ?? null; }

  // 에이전트 종료 시:
  //   1. _closed에 등록 → 이후 도착하는 질의는 ask()에서 즉시 응답
  //   2. 종료 시점에 이미 inbox에 있던 질의는 drain 후 일괄 자동 답변
  closeAgent(name, label) {
    this._closed.set(name, label);
    for (const q of this.drain(name)) {
      agentMsg(name, label, "progress", `↩ [종료] 질의 ${q.id} 자동 답변`, { toAgent: q.from, msgDir: "to" });
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
        agentMsg(name, label, "progress", `↩ [대기중] 질의 ${q.id} 자동 답변`, { toAgent: q.from, msgDir: "to" });
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

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

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
    if (response.usage) {
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      agentMsg(name, label, "tokens", "", { inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
    }
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
        agentMsg(name, label, "done", "분析 완료", { inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
        if (bus) {
          await bus.waitAndDrainUntilPredecessorsDone(name, label);
          bus.closeAgent(name, label);
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: "findings submitted" }] });
        messages.push({ role: "user", content: toolResults });
        finished = true;
        return { ...(block.input.findings || {}), inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
      }

      // ── ask_agent: 다른 에이전트에게 질의 (응답 대기) ──
      if (block.name === "ask_agent" && bus) {
        const { target, question } = block.input;
        agentMsg(name, label, "progress", `→ [${target}] 질의: ${question.slice(0, 80)}`, { toAgent: target, msgDir: "to" });
        try {
          const answer = await bus.ask(name, target, question);
          agentMsg(name, label, "progress", `← [${target}] 응답 수신`, { toAgent: target, msgDir: "from" });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: String(answer) }] });
        } catch (e) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: `오류: ${e.message}` }], is_error: true });
        }
        continue;
      }

      // ── answer_query: 수신된 질의에 답변 ──
      if (block.name === "answer_query" && bus) {
        const { query_id, answer } = block.input;
        const queryFrom = bus.queryFrom(query_id);
        bus.reply(query_id, answer);
        agentMsg(name, label, "progress", `↩ 질의 ${query_id} 답변 전송`, { toAgent: queryFrom, msgDir: "to" });
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

  agentMsg(name, label, "done", "완료", { inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
  if (bus) {
    await bus.waitAndDrainUntilPredecessorsDone(name, label);
    bus.closeAgent(name, label);
  }
  return { inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
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
    systemPrompt: `당신은 웹 UI 분析 에이전트입니다.

분析:
1. browser_get_page_info로 입력요소·버튼 수집
2. browser_screenshot으로 화면 확인
3. 발견마다 send_finding 호출 (폼필드·버튼역할·화면목적)

협업: 필요시 ask_agent("db","조회 조건 샘플 데이터 요청"), 수신 질의는 answer_query로 답변

write_report 전: ask_agent("db","[시나리오]:[필요 조건값/ID/코드값]")로 테스트데이터 요청 → 리포트 '## 테스트 케이스별 필요 데이터' 포함 (미설정시 '(DB 미확인)')

완료:
1. write_report: # UI 분析 리포트 / ## 페이지 개요 / ## 화면구성요소(폼필드·버튼) / ## 사용자액션 / ## 테스트 케이스별 필요 데이터
2. report_findings: pageTitle, purpose, formFields, buttons, sections, userActions, testData`,
    userMessage: `현재 URL: ${url}

HTML(일부):
\`\`\`html
${pageSource.slice(0, 6000)}
\`\`\`

send_finding으로 발견사항 전달 후 report_findings 호출.`,
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
    agentMsg("ui-source", "UI 소스 분析", "done", "GitLab 미설정 — 스킵");
    if (bus) bus.closeAgent("ui-source", "UI 소스 분析");
    return { skipped: true, levels: [], apiEndpoints: [] };
  }

  const projectIds = gitlab.getProjectIds();
  if (!projectIds.length) {
    agentMsg("ui-source", "UI 소스 분析", "done", "GITLAB_PROJECT 미설정 — 스킵");
    if (bus) bus.closeAgent("ui-source", "UI 소스 분析");
    return { skipped: true, levels: [], apiEndpoints: [] };
  }

  const urlPath     = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  const hintProject = projectFromUrl(url);
  const hintBranch  = hintProject ? branchFor(hintProject) : null;

  agentMsg(
    "ui-source", "UI 소스 분析", "progress",
    `프로젝트 IDs=[${projectIds.join(",")}], 경로=${urlPath}`,
  );

  return runAgent({
    name: "ui-source", label: "UI 소스 분析",
    bus,
    tools: [...GITLAB_IN_TOOLS, SEND_FINDING_TOOL, WRITE_REPORT_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 3-tier 소스 추적 에이전트입니다.
GitLab 프로젝트 IDs: [${projectIds.join(", ")}]
브랜치: get_branch_for_project 로 조회 (없으면 main).
모든 단계에서 프로젝트를 찾지 못하면 다음 ID로 전환 — 포기 금지.

[L0 — UI Vue] 경로="${urlPath}"
1. 각 프로젝트에서 gitlab_search_code_in으로 Vue Router에서 "${urlPath}" 검색 (결과 없으면 다음 프로젝트)
2. 매핑 컴포넌트 gitlab_get_file_in으로 읽기
3. import 추적 → API 클라이언트(src/api/) 엔드포인트 추출
4. send_finding(findingType:"api_endpoint", description에 method/path/파라미터)

[L1 — 중간계층] 각 L0 엔드포인트 *모두*:
1. derive_project_from_url 시도 → 실패유미발견 시 각 프로젝트 ID 순회
2. get_branch_for_project
3. gitlab_search_code_in으로 핸들러(@GetMapping 등) 검색
4. 다음 단계 API(RestTemplate/WebClient/Feign) 추출 → send_finding

[L2 — 백엔드] 각 L1 엔드포인트 *모두*:
1. derive_project_from_url 시도 → 실패유미발견 시 각 프로젝트 ID 순회
2. 컨트롤러→서비스→매퍼/리포지터리 추적
3. 비즈니스로직/DB테이블/권한/에러 → send_finding

write_report 전: ask_agent("db","[시나리오]:[필요 조건값/ID]")로 테스트데이터 요청 → '## 테스트 케이스별 필요 데이터' 포함 (미설정시 '(DB 미확인)')

완료:
1. write_report: # UI 소스 분析 리포트 / ## L0 / ## L1 / ## L2 / ## API목록 / ## 비즈니스로직 / ## 테스트 케이스별 필요 데이터
2. report_findings: { levels:[{level,project,branch,files,apiEndpoints},...], apiEndpoints:[...] }`,
    userMessage: `URL: ${url} / 경로: ${urlPath} / 프로젝트 IDs: [${projectIds.join(", ")}]${hintProject ? ` / URL 힌트: ${hintProject}(${hintBranch})` : ""}

각 프로젝트를 순회하며 L0→L1→L2 절차로 분析. send_finding으로 중간 발견 전달, 완료 후 report_findings 호출.`,
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
    systemPrompt: `당신은 Vue.js 프론트엔드 소스 分析 에이전트입니다.
GitLab 프로젝트 IDs: [${projectIds.join(", ")}]

분析:
1. 각 프로젝트에서 gitlab_search_code_in으로 Vue Router에서 현재 경로 검색
2. 매핑 컴포넌트 읽기(gitlab_get_file_in) → import 추적(하위컴포넌트·composables·src/api/)
3. API 클라이언트에서 엔드포인트 추출
결과 없으면 다음 프로젝트로 전환. 발견 즉시 send_finding: api_endpoint / validation_rule / business_logic

협업: 수신 질의 answer_query로 즉시 답변

write_report 전: ask_agent("db","[시나리오]:[필요 조건값/ID]")로 테스트데이터 요청 → '## 테스트 케이스별 필요 데이터' 포함

완료:
1. write_report: # Frontend 分析 리포트 / ## 라우터→컴포넌트 / ## API목록 / ## 유효성검증 / ## 폼필드 / ## 비즈니스로직 / ## 테스트 케이스별 필요 데이터
2. report_findings: routerFile, componentFile, componentFiles, apiEndpoints, validationRules, formFields, businessLogic`,
    userMessage: `URL: ${url} (경로: ${urlPath}) / 프로젝트 IDs: [${projectIds.join(", ")}]

Vue Router→컴포넌트→API 클라이언트 추적, send_finding → write_report → report_findings.`,
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


  const userMessage = endpoints.length
    ? `엔드포인트: ${JSON.stringify(endpoints).slice(0, 2000)} / 프로젝트 IDs: [${projectIds.join(", ")}]
컨트롤러/서비스 추적 후 send_finding → report_findings.`
    : `URL: ${url || "알 수 없음"} / 프로젝트 IDs: [${projectIds.join(", ")}]
URL 기반으로 소스 탐색 또는 answer_query 응답 후 report_findings 호출.`;

  return runAgent({
    name: "backend", label: "Backend 분析",
    bus,
    tools: [...GITLAB_IN_TOOLS, SEND_FINDING_TOOL, WRITE_REPORT_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 백엔드 소스 分析 에이전트입니다.
GitLab 프로젝트 IDs: [${projectIds.join(", ")}]

탐색(gitlab_*_in 도구):
1. 각 API 엔드포인트로 프로젝트 순서대로 핸들러 검색
   Spring: @GetMapping/@PostMapping / Node: router.get/post
   결과 없으면 다음 프로젝트로 전환, 포기 금지
2. 컨트롤러→서비스→리포지터리/매퍼 추적
3. DB쿼리·테이블명·비즈니스조건 파악
발견 즉시 send_finding: db_table / auth_rule / error_scenario / business_logic

협업:
- 수신 질의 answer_query로 즉시 답변
- DB 에이전트 쿼리 요청 시 소스 내 SQL/JPQL/마이바티스 쿼리·프로시저·테이블명 추출하여 답변

write_report 전: ask_agent("db","[시나리오]:[필요 조건값/ID]")로 테스트데이터 요청 → '## 테스트 케이스별 필요 데이터' 포함

완료:
1. write_report: # Backend 分析 리포트 / ## 대상엔드포인트 / ## 컨트롤러추적 / ## DB테이블 / ## 비즈니스로직 / ## 권한/인증 / ## 테스트시나리오 / ## 테스트 케이스별 필요 데이터
2. report_findings: controllerFiles, businessLogic, dbTables, authRules, errorScenarios, testScenarios`,
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
    ? `Backend 힌트 테이블: ${JSON.stringify(dbTables).slice(0, 500)} / API힌트: ${entityHints} / DB: ${configuredDbs.join(", ")}
Step1 지시대로 ask_agent("backend",...)로 실제 쿼리 먼저 수집. SELECT 자동 100건 제한.`
    : `URL: ${url || "알 수 없음"} / DB: ${configuredDbs.join(", ")}
ask_agent("backend",...)로 쿼리 수집 후 분析. SELECT 자동 100건 제한.`;

  return runAgent({
    name: "db", label: "DB 분석",
    bus,
    tools: [...buildDbTools(configuredDbs), SEND_FINDING_TOOL, WRITE_REPORT_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 DB 데이터 分析 에이전트입니다.
local=Tibero, center=MariaDB. SELECT는 시스템이 자동으로 최대 100건 강제.

Step1 — 쿼리 수집 (시작 즉시)
ask_agent("backend","이 화면 관련 SQL/JPQL/마이바티스 XML 쿼리 모두 제공. 포함: SELECT/INSERT/UPDATE/DELETE, 프로시저·함수, 테이블명, 조인")

Step2 — 쿼리 分析
테이블 목록·프로시저/함수→정의 조회·조인 관계·WHERE 컬럼/코드값 파악

Step3 — 샘플 조회
Tibero: SELECT ... FETCH FIRST 10 ROWS ONLY  또는  WHERE ROWNUM <= 10
MariaDB: SELECT ... LIMIT 10
프로시저(Tibero): SELECT * FROM ALL_SOURCE WHERE NAME='proc' ORDER BY LINE FETCH FIRST 100 ROWS ONLY
프로시저(MariaDB): SELECT ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_NAME='proc' LIMIT 1

Step4 — 타 에이전트 테스트 데이터 요청 응답
db_query로 실제 값 조회 후 answer_query를 아래 형식으로만 응답 (SQL·JSON 배열 직접 반환 금지):
[테스트케이스명]
ParamA: 실제값
ParamB: 실제값
대표값 1~3개. 없으면 "(해당 데이터 없음)". 모르는 테이블은 ask_agent("backend",...) 후 조회.

DB 용도: center=공통코드·권한·마스터, local=업무/도메인 데이터
데이터 발견 시 send_finding(findingType:"db_table")

완료:
1. write_report: # DB 分析 리포트 / ## 수집쿼리 / ## 테이블목록 / ## 프로시저/함수 / ## 샘플데이터 / ## 유효ID/코드 / ## 에이전트요청처리 / ## 활용가이드
2. report_findings: collectedQueries, tables, procedures, testData, validIds, agentDataProvided, summary`,
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
에이전트 리포트를 읽고 실행 가능한 테스트케이스를 도출합니다.

1. read_report 순서: findings-summary → ui → ui-source → frontend → backend → db
2. 종합하여 테스트케이스 도출
3. report_findings({ findings: { testCases: [...] } }) 제출

테스트케이스 형식:
{ "name":"[화면]-[시나리오]", "steps":[{"action":"navigate|click|type|key|scroll|screenshot","selector"?:"","text"?:"","url"?:"","key"?:""}], "testData":{}, "expectedResult":"" }

케이스 유형: 정상경로 / 유효성오류(필수값누락·형식오류) / 권한/인증 / 경계값(빈목록·최대값)
스킵된 에이전트는 무시, 확인된 정보만으로 반드시 도출.`,
    userMessage: `분析 URL: ${url}

read_report로 각 리포트 읽은 후 report_findings로 테스트케이스 제출.`,
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
  const leadIn = leadResult.inputTokens || 0;
  const leadOut = leadResult.outputTokens || 0;
  agentMsg("lead", "리드 에이전트", "done", `테스트 케이스 ${testCases.length}개 도출 완료`, { inputTokens: leadIn, outputTokens: leadOut });
  send({ type: "analyze-synthesis", testCases: testCases.map((tc) => ({ name: tc.name, expectedResult: tc.expectedResult })) });
  return { testCases, inputTokens: leadIn, outputTokens: leadOut };
}

// ── 6. Recording 에이전트 ─────────────────────────────────────────────────────
async function runRecordingAgent(tc, index, total) {
  send({ type: "analyze-recording", name: tc.name, index: index + 1, total });
  agentMsg("recording", `레코딩 ${index + 1}/${total}`, "start", tc.name);
  startRecording(tc.name);

  const agentResult = await runAgent({
    name: "recording",
    label: `레코딩 ${index + 1}/${total}`,
    tools: [...BROWSER_TOOLS, REPORT_TOOL],
    systemPrompt: `당신은 브라우저에서 테스트 케이스를 직접 실행하는 레코딩 에이전트입니다.

단계별 도구 매핑:
- navigate  → browser_navigate(url)
- click     → browser_click(selector, label)
- type      → browser_type(selector, text)
- key       → browser_key_press(key)
- scroll    → browser_scroll(x, y)
- screenshot → browser_screenshot()

모든 단계를 순서대로 빠짐없이 browser 도구를 사용해 실행하세요. 주요 액션 전후 browser_screenshot으로 상태 확인.
완료 후 report_findings({ "completed": true, "summary": "결과" }).`,
    userMessage: `[${index + 1}/${total}] ${tc.name}
예상결과: ${tc.expectedResult || ""}

실행 단계:
${JSON.stringify(tc.steps, null, 2)}

사용 데이터:
${JSON.stringify(tc.testData || {}, null, 2)}

위 단계를 순서대로 실행하세요.`,
    execTool: execBrowser,
    maxTurns: 30,
  });
  const recIn  = agentResult.inputTokens  || 0;
  const recOut = agentResult.outputTokens || 0;

  const id = await stopRecording();
  if (id) {
    log("success", `[레코딩] 저장: ${tc.name} (id=${id})`);
    send({ type: "recordings", list: dbAllMeta() });
    agentMsg("recording", `레코딩 ${index + 1}/${total}`, "done", `저장 완료 (id=${id})`, { inputTokens: recIn, outputTokens: recOut });
    return { id, inputTokens: recIn, outputTokens: recOut };
  }
  log("warn", `[레코딩] 이벤트 없음 — 미저장: ${tc.name}`);
  agentMsg("recording", `레코딩 ${index + 1}/${total}`, "done", "이벤트 없음 (미저장)", { inputTokens: recIn, outputTokens: recOut });
  return { id: null, inputTokens: recIn, outputTokens: recOut };
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
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  send({ type: "analyze-started", url });
  log("info", `━━ 분석 시작: ${url} ━━`);

  try {
    // 현재 페이지 DOM 수집
    let pageSource = "";
    try { pageSource = await state.activePage.evaluate(() => document.documentElement.outerHTML); } catch {}

    // ── Phase 1: 에이전트 팀 병렬 분석 (UI · 소스 · Frontend · Backend · DB) ──
    const { uiF, uiSourceF, frontendF, backendF, dbF } = await runAgentTeam(url, pageSource);
    for (const f of [uiF, uiSourceF, frontendF, backendF, dbF]) {
      totalInputTokens  += f.inputTokens  || 0;
      totalOutputTokens += f.outputTokens || 0;
    }

    if (state.analysisCancelled) throw new Error("취소됨");

    // ── Phase 2: Lead 에이전트 취합 → 테스트 케이스 도출 → 레코딩 ─────────────
    phaseMsg(2, 2, "테스트 케이스 도출 → 레코딩");
    const { testCases, inputTokens: leadIn = 0, outputTokens: leadOut = 0 } = await runLeadAgent(url);
    totalInputTokens  += leadIn;
    totalOutputTokens += leadOut;

    for (let i = 0; i < testCases.length; i++) {
      if (state.analysisCancelled) break;
      const recResult = await runRecordingAgent(testCases[i], i, testCases.length)
        .catch((e) => { agentMsg("recording", `레코딩 ${i + 1}`, "error", e.message); return null; });
      if (recResult?.id) createdCount++;
      totalInputTokens  += recResult?.inputTokens  || 0;
      totalOutputTokens += recResult?.outputTokens || 0;
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
    send({ type: "analyze-done", created: createdCount, totalInputTokens, totalOutputTokens });
  }
}

module.exports = { runAnalysis };
