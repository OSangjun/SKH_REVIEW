"use strict";

/**
 * analyzer.js — 멀티 에이전트 분석 시스템
 *
 * 에이전트 팀:
 *   UIAgent      : 현재 페이지 DOM/화면 구조 분석
 *   FrontendAgent: Vue Router → 컴포넌트 → API 클라이언트 탐색
 *   BackendAgent : API 엔드포인트 → 컨트롤러 → 서비스 탐색
 *   DBAgent      : center/local DB 테스트 데이터 조회
 *   LeadAgent    : 모든 에이전트 결과 취합 → 테스트 케이스 도출
 *   RecordingAgent: 각 테스트 케이스를 브라우저에서 직접 레코딩
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

/**
 * 범용 에이전트 루프
 * - send_finding: 중간 발견 즉시 전달 (웹소켓 + _sharedFindings)
 * - report_findings: 최종 결과 제출 후 루프 종료
 */
async function runAgent({ name, label, tools, systemPrompt, userMessage, maxTurns = 40, execTool }) {
  agentMsg(name, label, "start", "시작");
  const messages = [{ role: "user", content: userMessage }];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (state.analysisCancelled) throw new Error("분석 취소됨");

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn" || !response.content.some((b) => b.type === "tool_use")) break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (state.analysisCancelled) throw new Error("분석 취소됨");

      // ── send_finding: 즉시 전달 후 계속 ──
      if (block.name === "send_finding") {
        const { findingType, title, description, data } = block.input;
        findingMsg(name, label, findingType, title, description);
        _sharedFindings.push({ agent: name, label, findingType, title, description, data, ts: Date.now() });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: "finding received by lead agent" }] });
        continue;
      }

      // ── report_findings: 최종 제출 후 루프 종료 ──
      if (block.name === "report_findings") {
        agentMsg(name, label, "done", `분석 완료`);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: "findings submitted" }] });
        messages.push({ role: "user", content: toolResults });
        return block.input.findings || {};
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
    messages.push({ role: "user", content: toolResults });
  }

  agentMsg(name, label, "done", "완료");
  return {};
}

// ════════════════════════════════════════════════════════════════════════════
// 에이전트 팀
// ════════════════════════════════════════════════════════════════════════════

// ── 1. UI 에이전트 ───────────────────────────────────────────────────────────
async function runUIAgent(url, pageSource) {
  return runAgent({
    name: "ui", label: "UI 분석",
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
      REPORT_TOOL,
    ],
    systemPrompt: `당신은 웹 UI 분석 에이전트입니다.
현재 페이지의 UI 구조를 분석하여 비즈니스 로직을 파악합니다.

분석 방법:
1. browser_get_page_info로 입력 요소/버튼 목록 수집
2. browser_screenshot으로 화면 확인
3. 발견사항마다 send_finding 호출 (폼 필드, 버튼 역할, 화면 목적 등)
4. 분석 완료 후 report_findings 호출

report_findings 포함 내용:
- pageTitle: 페이지 제목
- purpose: 이 페이지의 역할 (1-2문장)
- formFields: [{id, name, type, label, placeholder, required}]
- buttons: [{label, type, role}]
- sections: 주요 화면 섹션 목록
- userActions: 사용자가 할 수 있는 주요 액션 목록`,
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

// ── 1a. UI 소스 분석 에이전트 ─────────────────────────────────────────────────
// 페이지 origin 다음 첫 path 세그먼트를 GitLab 프로젝트로 삼아 3-level chain
// (UI 프로젝트 → 중간 static-spring 프로젝트 → backend 프로젝트) 을 따라간다.
//
// 각 레벨에서 source 를 읽어 다음 레벨의 API 엔드포인트를 추출한다.
// 한 레벨에 여러 엔드포인트가 있으면 각각의 프로젝트를 병렬로 따라가도록
// 에이전트에게 지시한다 (실제 LLM 의 도구 호출은 직렬이지만 모든 엔드포인트를
// 검사하도록 강제).
async function runUISourceAgent(url) {
  if (!gitlab.isReady()) {
    agentMsg("ui-source", "UI 소스 분석", "done", "GitLab 미설정 — 스킵");
    return { skipped: true, levels: [], apiEndpoints: [] };
  }

  const uiProject = projectFromUrl(url);
  if (!uiProject) {
    agentMsg("ui-source", "UI 소스 분석", "done", "URL에서 프로젝트 도출 실패 — 스킵");
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
    tools: [...GITLAB_IN_TOOLS, SEND_FINDING_TOOL, REPORT_TOOL],
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

종료:
- 분석 완료 후 report_findings 호출. 포함 내용:
  {
    levels: [
      { level: 0, project, branch, files: [...], apiEndpoints: [{method, path}] },
      { level: 1, projects: [{project, branch, files, apiEndpoints}] },
      { level: 2, projects: [{project, branch, files, businessLogic, dbTables}] }
    ],
    apiEndpoints: [...], // 모든 레벨에서 발견한 엔드포인트 합본 (Frontend 에이전트가 재사용)
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
async function runFrontendAgent(url) {
  if (!gitlab.isConfigured()) {
    agentMsg("frontend", "Frontend 분석", "done", "GitLab 미설정 — 스킵");
    return { skipped: true, apiEndpoints: [], validationRules: [] };
  }
  const urlPath = (() => { try { return new URL(url).pathname; } catch { return url; } })();

  return runAgent({
    name: "frontend", label: "Frontend 분석",
    tools: [...GITLAB_TOOLS, SEND_FINDING_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 Vue.js 프론트엔드 소스 분석 에이전트입니다.
현재 URL 경로에 해당하는 Vue 컴포넌트를 추적하여 UI→API까지 분석합니다.

분석 순서:
1. gitlab_list_files("") → 프로젝트 루트 구조 파악
2. gitlab_search_code로 Vue Router에서 현재 경로("${urlPath}") 검색
3. 매핑된 Vue 컴포넌트 파일 읽기 (gitlab_get_file)
4. 컴포넌트의 import 문 추적:
   - 하위 컴포넌트 (src/components/ 등)
   - Composables / hooks (src/composables/)
   - API 클라이언트 파일 (src/api/, src/services/)
5. API 클라이언트에서 엔드포인트 경로 추출

비즈니스 로직 발견 시 즉시 send_finding 호출:
- API 엔드포인트 발견 → findingType: "api_endpoint"
- 유효성 검증 규칙 발견 → findingType: "validation_rule"
- 비즈니스 로직 발견 → findingType: "business_logic"

report_findings 포함:
- routerFile, componentFile: 파일 경로
- componentFiles: 읽은 모든 파일 목록
- apiEndpoints: [{method, path, description, requestParams, responseFields}]
- validationRules: [{field, rule, message}]
- formFields: [{name, type, required, validations}]
- businessLogic: 발견된 비즈니스 로직 설명 목록`,
    userMessage: `현재 페이지 URL: ${url} (경로: ${urlPath})

Vue Router에서 이 경로의 컴포넌트를 찾아 UI→API까지 추적하고,
발견사항을 send_finding으로 전달하면서 report_findings를 호출하세요.`,
    execTool: execGitlab,
  });
}

// ── 3. Backend 에이전트 ───────────────────────────────────────────────────────
async function runBackendAgent(frontendFindings) {
  if (!gitlab.isConfigured()) {
    agentMsg("backend", "Backend 분석", "done", "GitLab 미설정 — 스킵");
    return { skipped: true, businessLogic: [], dbTables: [], authRules: [] };
  }
  const endpoints = frontendFindings.apiEndpoints || [];
  if (!endpoints.length) {
    agentMsg("backend", "Backend 분석", "done", "API 엔드포인트 없음 — 스킵");
    return { skipped: true, businessLogic: [], dbTables: [], authRules: [] };
  }

  return runAgent({
    name: "backend", label: "Backend 분석",
    tools: [...GITLAB_TOOLS, SEND_FINDING_TOOL, REPORT_TOOL],
    systemPrompt: `당신은 백엔드 소스 분석 에이전트입니다.
프론트엔드 에이전트가 발견한 API 엔드포인트를 바탕으로 백엔드 컨트롤러/서비스를 분석합니다.

분석 순서:
1. 각 API 경로로 gitlab_search_code 검색
   - Spring: "@GetMapping", "@PostMapping" 등
   - Express/Koa: "router.get(", "router.post(" 등
2. 컨트롤러 파일 읽기
3. 서비스/레포지터리/매퍼 파일 읽기
4. DB 쿼리, 테이블명, 비즈니스 조건 파악

발견 시 즉시 send_finding 호출:
- DB 테이블 → findingType: "db_table"
- 권한/인증 규칙 → findingType: "auth_rule"
- 에러 시나리오 → findingType: "error_scenario"
- 비즈니스 로직 → findingType: "business_logic"

report_findings 포함:
- controllerFiles: 읽은 컨트롤러 파일 목록
- businessLogic: [{endpoint, description, conditions, errors}]
- dbTables: [{name, keyColumns, purpose}]
- authRules: 권한/인증 조건 목록
- errorScenarios: [{condition, errorMessage, httpStatus}]
- testScenarios: [{name, description, requiredData, expectedResult}]`,
    userMessage: `Frontend 분석 결과 (API 엔드포인트):
\`\`\`json
${JSON.stringify({ apiEndpoints: endpoints, validationRules: frontendFindings.validationRules || [] }, null, 2).slice(0, 4000)}
\`\`\`

각 엔드포인트의 백엔드 컨트롤러/서비스를 찾아 분석하고,
발견사항을 send_finding으로 전달하면서 report_findings를 호출하세요.`,
    execTool: execGitlab,
  });
}

// ── 4. DB 에이전트 ────────────────────────────────────────────────────────────
async function runDBAgent(frontendFindings, backendFindings) {
  const configuredDbs = db.configuredDbs();
  if (!configuredDbs.length) {
    agentMsg("db", "DB 분석", "done", "DB 미설정 — 스킵");
    return { skipped: true, testData: {}, validIds: {} };
  }

  const dbTables = backendFindings.dbTables || [];
  const entityHints = (frontendFindings.apiEndpoints || []).map((e) => e.path).join(", ");

  return runAgent({
    name: "db", label: "DB 분석",
    tools: [...buildDbTools(configuredDbs), SEND_FINDING_TOOL, REPORT_TOOL],
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

데이터 발견 시 send_finding 호출 (findingType: "db_table")

report_findings 포함:
- testData: {[테이블명]: [샘플 rows]}
- validIds: {[용도]: 값} (예: {"userId": 123, "deptCode": "A01"})
- summary: 확보한 테스트 데이터 요약`,
    userMessage: `Backend 분석 결과 (사용 테이블):
\`\`\`json
${JSON.stringify(dbTables, null, 2).slice(0, 3000)}
\`\`\`

API 경로 힌트: ${entityHints}
설정된 DB: ${configuredDbs.join(", ")}

테스트 데이터를 조회하고 report_findings를 호출하세요.`,
    execTool: execDb,
  });
}

// ── 5. Lead 에이전트 — 취합 및 테스트케이스 도출 ─────────────────────────────
async function runLeadAgent(url, uiF, frontendF, backendF, dbF) {
  agentMsg("lead", "리드 에이전트", "start", "전체 분석 결과 취합 중");

  const findingsSummary = _sharedFindings
    .map((f) => `[${f.label}] ${f.findingType}: ${f.title}${f.description ? " — " + f.description : ""}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8096,
    system: `당신은 QA 리드 에이전트입니다.
여러 분석 에이전트의 결과를 종합하여 실행 가능한 테스트 케이스 목록을 도출합니다.

각 테스트 케이스:
- name: "[화면명] - [시나리오]" 형식
- steps: 순서대로 수행할 액션 배열
  각 step 형식: { "action": "navigate|click|type|key|scroll|screenshot", "selector"?: "...", "text"?: "...", "url"?: "...", "key"?: "...", "x"?: 0, "y"?: 0 }
- testData: 실제 값 (DB에서 확보한 ID, 코드값 등)
- expectedResult: 예상 결과

포함할 케이스 유형:
1. 정상 경로 (Happy path) — 유효 데이터로 성공
2. 유효성 오류 — 필수값 누락, 형식 오류
3. 권한/인증 경계 — 미인증, 권한 없음 (해당하는 경우)
4. 경계값 — 빈 목록, 최대값

중요: 응답은 반드시 아래 JSON 형식만 출력하세요 (다른 텍스트 없음):
{"testCases":[{"name":"...","steps":[{"action":"navigate","url":"..."}],"testData":{},"expectedResult":"..."}]}`,
    messages: [{
      role: "user",
      content: `분석 URL: ${url}

## 에이전트 발견 목록 (실시간 전달된 내용)
${findingsSummary || "(없음)"}

## UI 분석 결과
\`\`\`json
${JSON.stringify(uiF, null, 2).slice(0, 2500)}
\`\`\`

## Frontend 분석 결과
\`\`\`json
${JSON.stringify(frontendF, null, 2).slice(0, 2500)}
\`\`\`

## Backend 분석 결과
\`\`\`json
${JSON.stringify(backendF, null, 2).slice(0, 2500)}
\`\`\`

## DB 데이터
\`\`\`json
${JSON.stringify(dbF, null, 2).slice(0, 2500)}
\`\`\`

위 모든 결과를 종합하여 테스트 케이스 JSON을 반환하세요.`,
    }],
  });

  const text = response.content.find((b) => b.type === "text")?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let testCases = [];
  if (jsonMatch) {
    try { testCases = JSON.parse(jsonMatch[0]).testCases || []; } catch {}
  }

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

    // ── Phase 1: UI 분석 (DOM) ───────────────────────────────────────────
    phaseMsg(1, 5, "UI 분석 (DOM/화면 구조)");
    const uiFindings = await runUIAgent(url, pageSource)
      .catch((e) => { agentMsg("ui", "UI 분석", "error", e.message); return {}; });

    if (state.analysisCancelled) throw new Error("취소됨");

    // ── Phase 2: UI 소스 분석 (3-tier 체인) ──────────────────────────────
    // 페이지 origin 다음 세그먼트 = 프로젝트로 잡고 Vue 컴포넌트부터
    // 중간 계층 / 백엔드 계층까지 소스코드를 따라가며 API 엔드포인트와
    // 비즈니스 로직을 수집한다. CLAUDE.md 매핑표에서 브랜치 조회.
    phaseMsg(2, 5, "UI 소스 분석 (3-tier 체인)");
    const uiSourceFindings = await runUISourceAgent(url)
      .catch((e) => { agentMsg("ui-source", "UI 소스 분석", "error", e.message); return {}; });

    if (state.analysisCancelled) throw new Error("취소됨");

    // ── Phase 3: Frontend 분석 (기존 — GITLAB_PROJECT env 기반) ─────────
    phaseMsg(3, 5, "Frontend 소스 분석");
    const frontendFindings = await runFrontendAgent(url)
      .catch((e) => { agentMsg("frontend", "Frontend 분석", "error", e.message); return {}; });

    // UI 소스 에이전트가 찾은 endpoint 를 Frontend 결과에 병합해 두면
    // 후속 Backend / DB 분석이 더 풍부한 입력을 받는다.
    if (uiSourceFindings && Array.isArray(uiSourceFindings.apiEndpoints)) {
      const merged = [
        ...(frontendFindings.apiEndpoints || []),
        ...uiSourceFindings.apiEndpoints,
      ];
      frontendFindings.apiEndpoints = merged;
    }

    if (state.analysisCancelled) throw new Error("취소됨");

    // ── Phase 4: Backend 분석 (Frontend 결과 활용) ───────────────────────
    phaseMsg(4, 5, "Backend 소스 분석");
    const backendFindings = await runBackendAgent(frontendFindings)
      .catch((e) => { agentMsg("backend", "Backend 분석", "error", e.message); return {}; });

    if (state.analysisCancelled) throw new Error("취소됨");

    // ── Phase 5: DB 분석 + Lead 취합 + 레코딩 ────────────────────────────
    phaseMsg(5, 5, "DB 데이터 분석 → 테스트 케이스 도출 → 레코딩");
    const dbFindings = await runDBAgent(frontendFindings, backendFindings)
      .catch((e) => { agentMsg("db", "DB 분석", "error", e.message); return {}; });

    if (state.analysisCancelled) throw new Error("취소됨");

    const testCases = await runLeadAgent(url, uiFindings, frontendFindings, backendFindings, dbFindings);

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
