"use strict";

/**
 * MCP Server — Puppeteer Recorder
 *
 * Claude CLI에서 이 서버를 MCP 툴로 사용하면:
 *   1. screenshot으로 현재 화면을 분석
 *   2. navigate / click / type_text / key_press 등으로 브라우저 조작
 *   3. start_recording / stop_recording으로 테스트케이스 녹화
 *
 * 기존 server.js / state.js 와 완전히 독립된 브라우저 인스턴스를 사용.
 * 녹화 결과는 동일한 SQLite DB에 저장되므로 GUI 웹 UI에서 바로 확인 가능.
 */

require("dotenv").config();

const puppeteer  = require("puppeteer-core");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const fs             = require("fs");
const nodePath       = require("path");
const { execSync }   = require("child_process");

const { dbSaveRecording } = require("./src/server/db");
const { isApiResponse }   = require("./src/shared/api-filter");
const { isTrackerUrl }    = require("./src/shared/blocklist");
const { pathUrl }         = require("./src/shared/url");

// ── 브라우저 설정 ─────────────────────────────────────────────────────────────
const CHROME_PATH = process.env.CHROME_PATH;
const VIEWPORT    = { width: 1280, height: 800 };

// ── MCP 전용 상태 (server.js / state.js 와 완전 독립) ────────────────────────
let browser = null;
let page    = null;

const rec = {
  active:    false,
  name:      "",
  startUrl:  "",
  startTime: null,
  events:    [],
  responses: [],
  pending:   new Set(),
};

// ── 브라우저 초기화 ───────────────────────────────────────────────────────────
async function ensureBrowser() {
  if (page && !page.isClosed()) return;

  if (!CHROME_PATH) {
    throw new Error(
      "CHROME_PATH 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요."
    );
  }

  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: VIEWPORT,
  });

  [page] = await browser.pages();

  // 녹화 중 HTTP 응답 캡처 (기존 isApiResponse / isTrackerUrl 필터 재사용)
  page.on("response", async (response) => {
    if (!rec.active) return;
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!isApiResponse(response)) return;
    if (isTrackerUrl(url)) return;

    const ct      = (response.headers()["content-type"] || "").toLowerCase();
    const wantBody = /json|text\/plain|xml/.test(ct);
    const status  = response.status();
    const t       = Date.now() - rec.startTime;
    const purl    = pathUrl(url); // path-only 저장 (환경 독립)

    if (!wantBody) {
      rec.responses.push({ url: purl, status, contentType: ct, body: null, t });
      return;
    }

    const p = response
      .buffer()
      .then((buf) => {
        rec.responses.push({
          url: purl, status, contentType: ct,
          body: buf.toString("utf8"), t,
        });
      })
      .catch(() => {
        rec.responses.push({ url: purl, status, contentType: ct, body: null, t });
      })
      .finally(() => rec.pending.delete(p));

    rec.pending.add(p);
  });

  browser.on("disconnected", () => { browser = null; page = null; });
}

// ── 이벤트 기록 헬퍼 ─────────────────────────────────────────────────────────
function recEvent(obj) {
  if (!rec.active) return;
  rec.events.push({ ...obj, t: Date.now() - rec.startTime });
}

// 좌표 → CSS 선택자 추출 (best-effort; 실패해도 리플레이는 좌표 폴백 사용)
async function selectorAt(x, y) {
  try {
    return await page.evaluate((px, py) => {
      const el = document.elementFromPoint(px, py);
      if (!el || el === document.body || el === document.documentElement) return null;
      if (el.id) return "#" + el.id;
      if (el.dataset && el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
      const safeCls = [...el.classList]
        .filter((c) => !/hover|active|focus|is-/.test(c))
        .slice(0, 2)
        .join(".");
      return safeCls ? `${el.tagName.toLowerCase()}.${safeCls}` : null;
    }, x, y);
  } catch {
    return null;
  }
}

// 현재 포커스된 요소의 선택자
async function focusedSelector() {
  try {
    return await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      if (el.id) return "#" + el.id;
      if (el.dataset && el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
      return el.tagName.toLowerCase();
    });
  } catch {
    return null;
  }
}

// 액션 후 네트워크 안정 대기
async function waitIdle(idleMs = 500) {
  await page
    .waitForNetworkIdle({ idleTime: idleMs, timeout: 8000 })
    .catch(() => {});
}

// ── MCP 서버 정의 ─────────────────────────────────────────────────────────────
const server = new Server(
  { name: "puppeteer-recorder", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── 툴 목록 ──────────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "screenshot",
      description:
        "현재 브라우저 화면을 JPEG 이미지로 반환합니다. " +
        "UI를 분석하거나 액션 결과를 확인할 때 호출하세요.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "navigate",
      description: "브라우저를 지정한 URL로 이동하고 페이지 로드를 기다립니다.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "이동할 전체 URL" },
        },
        required: ["url"],
      },
    },
    {
      name: "click",
      description:
        "화면의 (x, y) 좌표를 클릭합니다. " +
        "screenshot으로 좌표를 확인한 뒤 호출하세요.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "클릭 x 좌표 (픽셀)" },
          y: { type: "number", description: "클릭 y 좌표 (픽셀)" },
        },
        required: ["x", "y"],
      },
    },
    {
      name: "type_text",
      description:
        "현재 포커스된 입력 요소에 텍스트를 입력합니다. " +
        "입력 전에 click으로 해당 필드를 먼저 클릭하세요.",
      inputSchema: {
        type: "object",
        properties: {
          text:        { type: "string",  description: "입력할 텍스트" },
          clear_first: { type: "boolean", description: "기존 내용 삭제 후 입력 (기본: false)" },
        },
        required: ["text"],
      },
    },
    {
      name: "key_press",
      description:
        "키보드 키를 누릅니다. " +
        "예: Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Puppeteer 키 이름 (예: Enter, Tab)" },
        },
        required: ["key"],
      },
    },
    {
      name: "hover",
      description:
        "마우스를 지정 좌표로 이동합니다. " +
        "드롭다운 메뉴를 열거나 툴팁을 표시할 때 사용하세요.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["x", "y"],
      },
    },
    {
      name: "scroll",
      description: "지정 좌표에서 스크롤합니다.",
      inputSchema: {
        type: "object",
        properties: {
          x:       { type: "number" },
          y:       { type: "number" },
          delta_x: { type: "number", description: "가로 스크롤 픽셀 (우: 양수)" },
          delta_y: { type: "number", description: "세로 스크롤 픽셀 (아래: 양수)" },
        },
        required: ["x", "y", "delta_x", "delta_y"],
      },
    },
    {
      name: "get_page_info",
      description:
        "현재 페이지의 URL, 제목, 표시된 입력 요소(좌표 포함)를 반환합니다. " +
        "UI 구조 파악과 클릭 좌표 결정에 활용하세요.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "start_recording",
      description:
        "새 테스트케이스 녹화를 시작합니다. " +
        "이후의 navigate / click / type_text 등 모든 액션이 자동 기록됩니다.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "테스트케이스 이름" },
        },
        required: ["name"],
      },
    },
    {
      name: "stop_recording",
      description:
        "녹화를 종료하고 SQLite DB에 저장합니다. " +
        "반환된 케이스 ID로 웹 UI 또는 CLI에서 리플레이할 수 있습니다.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_recording_status",
      description: "현재 녹화 상태(활성 여부, 이벤트 수, 경과 시간)를 반환합니다.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "read_file",
      description:
        "소스 파일을 읽어 내용을 반환합니다. " +
        "Vue 컴포넌트, 라우터, API 클라이언트, Spring Boot 컨트롤러 등을 읽어 " +
        "테스트 시나리오 도출에 활용하세요.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "읽을 파일의 절대 또는 상대 경로" },
          max_lines: { type: "number", description: "최대 반환 줄 수 (기본: 500)" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "find_files",
      description:
        "디렉토리에서 파일을 검색합니다. " +
        "예: { dir: './src', pattern: '*.vue' } → 모든 Vue 컴포넌트 목록 반환. " +
        "node_modules / .git 은 자동 제외됩니다.",
      inputSchema: {
        type: "object",
        properties: {
          dir:         { type: "string", description: "검색 시작 디렉토리" },
          pattern:     { type: "string", description: "파일명 패턴 (예: *.vue, *controller*.java)" },
          max_results: { type: "number", description: "최대 결과 수 (기본: 50)" },
        },
        required: ["dir"],
      },
    },
  ],
}));

// ── 툴 실행 ──────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // 브라우저 초기화 (최초 호출 시 1회)
  try {
    await ensureBrowser();
  } catch (err) {
    return {
      content: [{ type: "text", text: `브라우저 초기화 실패: ${err.message}` }],
      isError: true,
    };
  }

  try {
    // ── screenshot ──────────────────────────────────────────────────────────
    if (name === "screenshot") {
      const data = await page.screenshot({
        type: "jpeg", quality: 80, encoding: "base64",
      });
      return { content: [{ type: "image", data, mimeType: "image/jpeg" }] };
    }

    // ── navigate ────────────────────────────────────────────────────────────
    if (name === "navigate") {
      const { url } = args;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitIdle();
      recEvent({ type: "navigate", url });
      return { content: [{ type: "text", text: `이동 완료: ${page.url()}` }] };
    }

    // ── click ───────────────────────────────────────────────────────────────
    if (name === "click") {
      const { x, y } = args;
      const selector = await selectorAt(x, y);
      await page.mouse.click(x, y);
      await waitIdle();
      recEvent({ type: "click", x, y, selector: selector || "", label: "" });
      const hint = selector ? ` → ${selector}` : "";
      return { content: [{ type: "text", text: `클릭 완료 (${x}, ${y})${hint}` }] };
    }

    // ── type_text ───────────────────────────────────────────────────────────
    if (name === "type_text") {
      const { text, clear_first = false } = args;
      if (clear_first) {
        await page.keyboard.down("Control");
        await page.keyboard.press("a");
        await page.keyboard.up("Control");
      }
      await page.keyboard.type(text, { delay: 30 });
      await waitIdle(200);
      const selector = await focusedSelector();
      recEvent({ type: "input", value: text, selector: selector || "", label: "" });
      return { content: [{ type: "text", text: `입력 완료: "${text}"` }] };
    }

    // ── key_press ───────────────────────────────────────────────────────────
    if (name === "key_press") {
      const { key } = args;
      await page.keyboard.press(key);
      await waitIdle();
      recEvent({ type: "keydown", key, selector: "", label: "" });
      return { content: [{ type: "text", text: `키 입력: ${key}` }] };
    }

    // ── hover ───────────────────────────────────────────────────────────────
    if (name === "hover") {
      const { x, y } = args;
      const selector = await selectorAt(x, y);
      await page.mouse.move(x, y);
      await waitIdle(300);
      recEvent({ type: "hover", x, y, selector: selector || "", label: "" });
      return { content: [{ type: "text", text: `호버 완료 (${x}, ${y})` }] };
    }

    // ── scroll ──────────────────────────────────────────────────────────────
    if (name === "scroll") {
      const { x, y, delta_x, delta_y } = args;
      await page.mouse.move(x, y);
      await page.mouse.wheel({ deltaX: delta_x, deltaY: delta_y });
      await waitIdle(200);
      recEvent({ type: "scroll", x, y, deltaX: delta_x, deltaY: delta_y });
      return {
        content: [{ type: "text", text: `스크롤 완료 (Δx=${delta_x}, Δy=${delta_y})` }],
      };
    }

    // ── get_page_info ───────────────────────────────────────────────────────
    if (name === "get_page_info") {
      const info = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0;
        };
        const elements = [
          ...document.querySelectorAll(
            'input:not([type=hidden]), select, textarea, button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"]'
          ),
        ]
          .filter(visible)
          .slice(0, 40)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              tag:         el.tagName.toLowerCase(),
              type:        el.type || null,
              text:        (el.innerText || el.value || el.placeholder || "").trim().slice(0, 60),
              id:          el.id || null,
              testid:      el.dataset.testid || null,
              cx:          Math.round(r.left + r.width  / 2),
              cy:          Math.round(r.top  + r.height / 2),
            };
          });
        return { url: location.href, title: document.title, elements };
      });
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }

    // ── start_recording ─────────────────────────────────────────────────────
    if (name === "start_recording") {
      if (rec.active) {
        return {
          content: [{ type: "text", text: "이미 녹화 중입니다. stop_recording을 먼저 호출하세요." }],
          isError: true,
        };
      }
      rec.active    = true;
      rec.name      = args.name;
      rec.startUrl  = page.url();
      rec.startTime = Date.now();
      rec.events    = [];
      rec.responses = [];
      rec.pending   = new Set();
      return {
        content: [{
          type: "text",
          text: `녹화 시작\n이름: "${rec.name}"\nURL: ${rec.startUrl}`,
        }],
      };
    }

    // ── stop_recording ──────────────────────────────────────────────────────
    if (name === "stop_recording") {
      if (!rec.active) {
        return {
          content: [{ type: "text", text: "녹화 중이 아닙니다." }],
          isError: true,
        };
      }
      rec.active = false;

      if (rec.pending.size > 0) {
        await Promise.allSettled([...rec.pending]);
      }

      const id = dbSaveRecording(
        rec.name,
        rec.startUrl,
        rec.events.length,
        new Date().toISOString(),
        rec.events,
        rec.responses,
        [],  // cookies
        [],  // toasts
      );

      return {
        content: [{
          type: "text",
          text: [
            `녹화 저장 완료`,
            `케이스 ID : ${id}`,
            `이름      : ${rec.name}`,
            `이벤트    : ${rec.events.length}개`,
            `HTTP 응답 : ${rec.responses.length}개`,
            ``,
            `웹 UI(http://localhost:3000) 또는 CLI(node run-tests.js --id ${id})로 리플레이할 수 있습니다.`,
          ].join("\n"),
        }],
      };
    }

    // ── get_recording_status ────────────────────────────────────────────────
    if (name === "get_recording_status") {
      const text = rec.active
        ? [
            `상태      : 녹화 중`,
            `이름      : ${rec.name}`,
            `이벤트    : ${rec.events.length}개`,
            `HTTP 응답 : ${rec.responses.length}개`,
            `경과 시간 : ${Math.round((Date.now() - rec.startTime) / 1000)}초`,
          ].join("\n")
        : "상태: 대기 중 (start_recording을 호출하면 녹화를 시작합니다)";
      return { content: [{ type: "text", text }] };
    }

    // ── read_file ───────────────────────────────────────────────────────────
    if (name === "read_file") {
      const { file_path, max_lines = 500 } = args;
      const abs = nodePath.resolve(file_path);
      if (!fs.existsSync(abs)) {
        return { content: [{ type: "text", text: `파일 없음: ${abs}` }], isError: true };
      }
      const stat = fs.statSync(abs);
      if (stat.size > 512 * 1024) {
        return {
          content: [{ type: "text", text: `파일이 너무 큽니다 (${Math.round(stat.size / 1024)}KB). max_lines를 줄이거나 find_files로 더 작은 파일을 먼저 탐색하세요.` }],
          isError: true,
        };
      }
      const raw    = fs.readFileSync(abs, "utf8");
      const lines  = raw.split("\n");
      const clipped = lines.length > max_lines;
      const text   = clipped
        ? lines.slice(0, max_lines).join("\n") +
          `\n\n... (총 ${lines.length}줄, 처음 ${max_lines}줄만 표시. max_lines 파라미터로 조정 가능)`
        : raw;
      return { content: [{ type: "text", text }] };
    }

    // ── find_files ──────────────────────────────────────────────────────────
    if (name === "find_files") {
      const { dir, pattern = "*", max_results = 50 } = args;
      const abs = nodePath.resolve(dir);
      if (!fs.existsSync(abs)) {
        return { content: [{ type: "text", text: `디렉토리 없음: ${abs}` }], isError: true };
      }
      try {
        const out = execSync(
          `find "${abs}" -type f -name "${pattern}" ` +
          `-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/target/*" -not -path "*/build/*" ` +
          `| sort | head -${max_results}`,
          { encoding: "utf8", timeout: 10000 }
        );
        const files = out.trim().split("\n").filter(Boolean);
        const text  = files.length
          ? files.join("\n") + (files.length >= max_results ? `\n\n(결과가 ${max_results}개로 제한됨)` : "")
          : "해당 파일 없음";
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `검색 오류: ${err.message}` }], isError: true };
      }
    }

    return {
      content: [{ type: "text", text: `알 수 없는 툴: ${name}` }],
      isError: true,
    };

  } catch (err) {
    return {
      content: [{ type: "text", text: `오류: ${err.message}\n${err.stack}` }],
      isError: true,
    };
  }
});

// ── 시작 ─────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr로 출력 (stdout은 MCP 프로토콜 전용)
  process.stderr.write("[MCP] Puppeteer Recorder MCP Server 시작됨\n");
}

main().catch((err) => {
  process.stderr.write(`[MCP] 시작 실패: ${err.message}\n`);
  process.exit(1);
});
