"use strict";

/**
 * analyzer.js — 분석 버튼 에이전트
 *
 * runAnalysis(url):
 *   1. GitLab REST API로 현재 페이지 관련 소스 수집
 *   2. Claude (claude-sonnet-4-6) tool_use 루프로 비즈니스 로직 분석
 *   3. DB 쿼리로 실제 테스트 데이터 획득
 *   4. 각 테스트 케이스를 브라우저에서 직접 레코딩
 */

const Anthropic = require("@anthropic-ai/sdk");
const state = require("./state");
const { send, log } = require("./comms");
const { dbSaveRecording, dbUpdateName, dbAllMeta } = require("./db");
const { mapResponsesToEvents } = require("./replay");
const { isApiResponse } = require("../shared/api-filter");
const { isTrackerUrl } = require("../shared/blocklist");
const { pathUrl } = require("../shared/url");
const gitlab = require("./gitlab-client");
const db = require("./db-client");

const SKIP_KEYS = new Set(["Process", "Unidentified", "Dead", "Compose", "OS"]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitIdle(timeout = 8000, idleTime = 500) {
  try { await state.activePage.waitForNetworkIdle({ idleTime, timeout }); } catch {}
}

// ── Tool definitions ────────────────────────────────────────────────────────

function buildTools() {
  const tools = [];

  // GitLab tools (only if configured)
  if (gitlab.isConfigured()) {
    tools.push(
      {
        name: "gitlab_list_files",
        description: "GitLab 저장소의 특정 경로에 있는 파일/디렉터리 목록을 반환합니다.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "조회할 경로 (예: 'src/views'). 빈 문자열이면 루트." },
            ref:  { type: "string", description: "브랜치/태그/커밋 (기본값: main)" },
          },
          required: [],
        },
      },
      {
        name: "gitlab_get_file",
        description: "GitLab 저장소에서 특정 파일의 내용을 반환합니다.",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "파일 경로 (예: 'src/views/Login.vue')" },
            ref: { type: "string", description: "브랜치/태그/커밋 (기본값: main)" },
          },
          required: ["file_path"],
        },
      },
      {
        name: "gitlab_search_code",
        description: "GitLab 저장소에서 코드를 검색합니다.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "검색어" },
          },
          required: ["query"],
        },
      },
    );
  }

  // DB tool (only if at least one DB is configured)
  const configuredDbs = db.configuredDbs();
  if (configuredDbs.length > 0) {
    tools.push({
      name: "db_query",
      description: `데이터베이스에 SQL을 실행하여 테스트 데이터를 조회합니다. db 파라미터로 접속할 DB를 지정하세요 (${configuredDbs.join(", ")}). SELECT만 허용.\n- local DB: 도메인/업무 데이터 (사용자, 계정, 거래 데이터 등)\n- center DB: 공통/마스터 데이터 (코드, 권한, 기준 데이터 등)`,
      input_schema: {
        type: "object",
        properties: {
          sql:    { type: "string", description: "실행할 SELECT SQL 쿼리" },
          params: { type: "array",  description: "바인딩 파라미터 배열", items: { type: "string" } },
          db:     { type: "string", enum: configuredDbs, description: `조회할 DB 이름 (${configuredDbs.join(" | ")})` },
        },
        required: ["sql", "db"],
      },
    });
  }

  // Browser tools
  tools.push(
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
          selector: { type: "string", description: "CSS 선택자 (없으면 x, y 좌표 사용)" },
          x: { type: "number" },
          y: { type: "number" },
          label: { type: "string", description: "클릭할 요소의 텍스트 레이블 (선택사항, 동명 요소 구분용)" },
        },
        required: [],
      },
    },
    {
      name: "browser_type",
      description: "입력 필드에 텍스트를 입력합니다. 기존 값은 지워집니다.",
      input_schema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 선택자" },
          text: { type: "string", description: "입력할 텍스트" },
        },
        required: ["text"],
      },
    },
    {
      name: "browser_key_press",
      description: "키보드 키를 누릅니다 (예: Enter, Tab, Escape).",
      input_schema: {
        type: "object",
        properties: { key: { type: "string", description: "키 이름 (예: Enter, Tab, Escape, ArrowDown)" } },
        required: ["key"],
      },
    },
    {
      name: "browser_scroll",
      description: "페이지를 스크롤합니다.",
      input_schema: {
        type: "object",
        properties: {
          x: { type: "number", description: "스크롤 X 위치" },
          y: { type: "number", description: "스크롤 Y 위치" },
        },
        required: ["x", "y"],
      },
    },
    {
      name: "browser_get_page_info",
      description: "현재 페이지의 URL, 제목, 주요 입력 요소 목록을 반환합니다.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "recording_start",
      description: "테스트 케이스 레코딩을 시작합니다. 이후 browser_* 도구로 조작한 내용이 기록됩니다.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "테스트 케이스 이름 (예: '로그인 - 정상')" } },
        required: ["name"],
      },
    },
    {
      name: "recording_stop",
      description: "현재 레코딩을 종료하고 SQLite에 저장합니다. 반드시 recording_start와 짝으로 호출해야 합니다.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
  );

  return tools;
}

// ── Tool execution ──────────────────────────────────────────────────────────

// Recording state (independent of ws-handler recording to avoid state collisions)
let _recStartTime = null;
let _recEvents = [];
let _recResponses = [];
let _recPending = new Set();
let _recHandler = null;
let _recName = "";

function startRecording(name) {
  _recName = name;
  _recStartTime = Date.now();
  _recEvents = [{ type: "navigate", url: state.currentUrl, t: 0 }];
  _recResponses = [];
  _recPending = new Set();

  _recHandler = (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    if (isTrackerUrl(url)) return;
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const status = response.status();
    const wantBody = /json|text\/plain|xml/.test(ct);
    const t = Date.now() - _recStartTime;
    const purl = pathUrl(url);
    if (!wantBody) {
      _recResponses.push({ url: purl, status, contentType: ct, body: null, t });
      return;
    }
    const p = response
      .buffer()
      .then((buf) => _recResponses.push({ url: purl, status, contentType: ct, body: buf.toString("utf8"), t }))
      .catch(() => _recResponses.push({ url: purl, status, contentType: ct, body: null, t }))
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

  if (_recEvents.length <= 1) return null; // navigate만 있으면 저장하지 않음

  const eventsWithMap = mapResponsesToEvents([..._recEvents], [..._recResponses]);
  const id = dbSaveRecording(
    _recName,
    state.currentUrl,
    _recEvents.length,
    new Date().toISOString(),
    eventsWithMap,
    [..._recResponses],
    [...state.sessionCookies],
    [],
  );
  dbUpdateName(id, _recName);
  return id;
}

function addRecordedEvent(ev) {
  if (!_recHandler) return;
  _recEvents.push({ ...ev, t: Date.now() - _recStartTime });
}

async function executeTool(name, input) {
  const page = state.activePage;
  if (!page) return { error: "브라우저 세션이 없습니다." };

  try {
    switch (name) {
      // ── GitLab ──
      case "gitlab_list_files":
        return { files: await gitlab.listFiles(input.path || "", input.ref || "main") };
      case "gitlab_get_file":
        return { content: await gitlab.getFile(input.file_path, input.ref || "main") };
      case "gitlab_search_code":
        return { results: await gitlab.searchCode(input.query) };

      // ── DB ──
      case "db_query": {
        const sql = (input.sql || "").trim();
        if (!/^select/i.test(sql)) return { error: "SELECT 쿼리만 허용됩니다." };
        const dbName = input.db || "local";
        const rows = await db.query(sql, input.params || [], dbName);
        return { rows, count: rows.length, db: dbName };
      }

      // ── Browser ──
      case "browser_screenshot": {
        const buf = await page.screenshot({ type: "jpeg", quality: 75 });
        return { image: buf.toString("base64"), mimeType: "image/jpeg" };
      }
      case "browser_navigate": {
        if (state.sessionCookies.length > 0)
          await page.setCookie(...state.sessionCookies);
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
        const info = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll("input, textarea, select, button")).slice(0, 30).map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            id: el.id || null,
            name: el.name || null,
            placeholder: el.placeholder || null,
            text: (el.innerText || el.textContent || "").trim().slice(0, 80),
            visible: el.getBoundingClientRect().width > 0,
          }));
          return { url: location.href, title: document.title, inputs };
        });
        return info;
      }

      // ── Recording ──
      case "recording_start": {
        if (_recHandler) await stopRecording(); // 이전 레코딩이 끊기지 않았으면 정리
        startRecording(input.name || "분석 테스트");
        log("info", `[분석] 레코딩 시작: ${input.name}`);
        send({ type: "analyze-recording", name: input.name });
        return { started: true, name: input.name };
      }
      case "recording_stop": {
        const id = await stopRecording();
        if (id) {
          log("success", `[분석] 레코딩 저장 → id=${id}, 케이스: ${_recName}`);
          send({ type: "recordings", list: dbAllMeta() });
          return { saved: true, id, name: _recName };
        }
        return { saved: false, reason: "이벤트 없음" };
      }

      default:
        return { error: `알 수 없는 도구: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ── Main agent loop ─────────────────────────────────────────────────────────

async function runAnalysis(url) {
  if (state.isAnalyzing) {
    send({ type: "analyze-error", message: "이미 분석이 진행 중입니다." });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    send({ type: "analyze-error", message: "ANTHROPIC_API_KEY가 설정되지 않았습니다." });
    return;
  }

  state.isAnalyzing = true;
  state.analysisCancelled = false;
  let createdCount = 0;

  send({ type: "analyze-started", url });
  log("info", `━━ 분석 시작: ${url} ━━`);

  try {
    // 현재 페이지 DOM 요약 (프롬프트 컨텍스트)
    let pageSource = "";
    try {
      pageSource = await state.activePage.evaluate(() => {
        // body 텍스트 + 주요 attributes 요약 (너무 크면 잘라냄)
        return document.documentElement.outerHTML.slice(0, 8000);
      });
    } catch {}

    const systemPrompt = `당신은 웹 애플리케이션 QA 엔지니어입니다.
주어진 URL의 페이지를 UI부터 백엔드까지 전체 스택을 분석하여 테스트 케이스를 도출하고 직접 레코딩합니다.

## 분석 단계 (순서대로 수행)

### Phase 1: 라우터 → Vue 컴포넌트 탐색 (GitLab 도구가 있을 때)
1. gitlab_list_files("") 로 프로젝트 루트 구조 파악
2. gitlab_search_code 로 현재 URL 경로에 해당하는 Vue Router 설정 검색
   예: URL이 "/login" 이면 "path: '/login'" 또는 "'/login'" 검색
3. 라우터에서 매핑된 Vue 컴포넌트 파일 경로 확인
4. gitlab_get_file 로 해당 컴포넌트 파일 읽기

### Phase 2: Vue 컴포넌트 → 하위 컴포넌트 / API 클라이언트 탐색
1. 컴포넌트 import 문에서 하위 컴포넌트, composable, API 클라이언트(src/api/ 등) 파악
2. 각 참조 파일을 gitlab_get_file 로 추가 읽기
3. 수집 정보:
   - 폼 필드 목록 (v-model, :value 바인딩)
   - 유효성 검증 규칙 (required, pattern, min/max 등)
   - 이벤트 핸들러 및 API 호출 함수
   - API 엔드포인트 경로 (예: '/api/v1/users', '/api/auth/login')

### Phase 3: API 클라이언트 → 백엔드 컨트롤러 / 서비스 탐색
1. API 클라이언트 파일에서 엔드포인트 경로 추출
2. gitlab_search_code 로 해당 경로를 처리하는 백엔드 컨트롤러 검색
   예: "@GetMapping(\"/users\")" 또는 "router.get('/users'" 검색
3. 컨트롤러 파일 읽기 → 서비스 파일로 이동
4. 수집 정보:
   - 비즈니스 로직 분기 조건
   - 권한/인증 검사 (예: @PreAuthorize, middleware)
   - DB 쿼리에서 사용하는 테이블/컬럼 파악

### Phase 4: DB 데이터 조회 (DB 도구가 있을 때)
- center DB: 공통/마스터 데이터 조회 (공통코드, 권한, 기준 데이터 등)
- local DB: 도메인/업무 데이터 조회 (사용자, 계정, 거래 데이터 등)
- 각 DB에서 테스트에 필요한 실제 ID, 코드값, 조건값 획득
- 두 DB 모두 설정된 경우 두 곳 모두 조회

### Phase 5: 테스트 케이스 계획 및 레코딩
소스 분석 결과를 바탕으로 아래 유형의 케이스 계획:
- 정상 경로 (Happy path): 유효한 데이터로 성공 시나리오
- 유효성 검증 오류: 필수값 누락, 형식 오류, 범위 초과
- 권한/인증 경계: 미인증 접근, 권한 없는 작업
- 경계값: 빈 목록, 최대값, 특수문자

각 케이스 레코딩 순서:
a. recording_start("케이스명")  ← 반드시 호출
b. browser_navigate(url)
c. browser_screenshot → 화면 확인
d. browser_click / browser_type / browser_key_press 등으로 시나리오 수행
e. recording_stop()  ← 반드시 호출

## 케이스 이름 규칙
"[화면명] - [시나리오]"
예: "로그인 - 정상", "로그인 - 비밀번호 오류", "사용자 목록 - 검색"

## 대체 전략
- GitLab 도구 없음: browser_get_page_info + browser_screenshot 으로 DOM 기반 분석
- DB 도구 없음: 고정 테스트 데이터로 시나리오 구성

## 주의사항
- recording_start와 recording_stop은 반드시 짝으로 호출 (짝이 맞지 않으면 저장 안 됨)
- 한 케이스 recording_stop 후 즉시 다음 케이스 시작
- 분석 완료 후 도구 호출 없이 완료 메시지만 반환`;

    const userMessage = `현재 URL: ${url}

현재 페이지 HTML (일부):
\`\`\`html
${pageSource}
\`\`\`

위 페이지를 분석하고 테스트 케이스를 레코딩해주세요.`;

    const client = new Anthropic();
    const tools = buildTools();
    const messages = [{ role: "user", content: userMessage }];

    let step = 0;
    const MAX_TURNS = 80; // 무한루프 방지

    while (step < MAX_TURNS) {
      if (state.analysisCancelled) {
        log("warn", "[분석] 취소됨");
        break;
      }

      step++;
      send({ type: "analyze-progress", step, message: `에이전트 루프 ${step}번째` });

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      // 종료 조건: end_turn 또는 tool_use 없음
      if (response.stop_reason === "end_turn") break;
      if (!response.content.some((b) => b.type === "tool_use")) break;

      // 도구 실행
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        if (state.analysisCancelled) break;

        log("info", `[분석] 도구 호출: ${block.name} ${JSON.stringify(block.input).slice(0, 120)}`);
        const result = await executeTool(block.name, block.input);

        if (block.name === "recording_stop" && result.saved) createdCount++;

        // 스크린샷은 image 블록으로 전달
        let content;
        if (block.name === "browser_screenshot" && result.image) {
          content = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: result.image } }];
        } else {
          content = [{ type: "text", text: JSON.stringify(result) }];
        }

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
      }

      messages.push({ role: "user", content: toolResults });
    }

    // 레코딩 중인 게 있으면 강제 종료
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
