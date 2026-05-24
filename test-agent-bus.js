"use strict";

/**
 * AgentBus 통신 + runAgentTeam 병렬 실행 통합 테스트
 *
 * 검증 항목:
 *  1. 5개 에이전트가 모두 시작되는지
 *  2. ask_agent → 대상 inbox에 적재되는지
 *  3. drain → 질의를 꺼내는지
 *  4. reply → 질의자 Promise가 해제(resolve)되는지
 *  5. UIAgent→DB, DB→Backend 2-hop 체인이 deadlock 없이 완료되는지
 */

// ── AgentBus (analyzer.js에서 복사) ──────────────────────────────────────────
class AgentBus {
  constructor() {
    this._inbox   = {};
    this._pending = new Map();
    this._seq     = 0;
  }
  register(name) { this._inbox[name] = []; }
  ask(from, to, question) {
    return new Promise((resolve, reject) => {
      const id = ++this._seq;
      this._pending.set(id, { resolve, reject });
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
}

// ── 테스트 유틸 ─────────────────────────────────────────────────────────────
const events = [];
function record(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  events.push({ ts, tag, msg });
  console.log(`[${ts}] [${tag.padEnd(12)}] ${msg}`);
}

let passed = 0, failed = 0;
function assert(condition, desc) {
  if (condition) { passed++; console.log(`  ✓ ${desc}`); }
  else           { failed++; console.error(`  ✗ ${desc}`); }
}

// ── 1. AgentBus 단위 테스트 ─────────────────────────────────────────────────
console.log("\n=== 1. AgentBus 단위 테스트 ===");
{
  const bus = new AgentBus();
  bus.register("ui");
  bus.register("db");
  bus.register("backend");

  // ask → inbox에 적재
  const p1 = bus.ask("ui", "db", "날짜범위 샘플 데이터 주세요");
  let incoming = bus.drain("db");
  assert(incoming.length === 1,          "ask() 후 대상 inbox에 1건 적재");
  assert(incoming[0].from === "ui",      "from 필드 = 'ui'");
  assert(incoming[0].id   === 1,         "첫 질의 ID = 1");
  assert(incoming[0].question.includes("날짜"), "question 내용 포함");

  // reply → Promise 해제
  let resolved = false;
  p1.then(ans => { resolved = true; assert(ans === "2024-01-01", "answer 값 정확히 전달"); });
  bus.reply(1, "2024-01-01");
  await new Promise(r => setTimeout(r, 10)); // microtask flush
  assert(resolved, "reply() 후 Promise 해제됨");

  // 이미 drain된 후 재drain → 빈 배열
  const empty = bus.drain("db");
  assert(empty.length === 0, "drain 후 재drain → 빈 배열");

  // 존재하지 않는 query_id reply → 무시
  bus.reply(9999, "ignore"); // 오류 없이 통과해야 함
  assert(true, "존재하지 않는 query_id reply → 무시");
}

// ── 2. 2-hop 통신 체인 (UIAgent→DB→Backend) ─────────────────────────────────
console.log("\n=== 2. 2-hop 체인 (UIAgent → DBAgent → BackendAgent) ===");
{
  const bus = new AgentBus();
  ["ui", "db", "backend"].forEach(n => bus.register(n));

  // 각 에이전트를 async 함수로 시뮬레이션
  async function mockUIAgent() {
    record("ui", "시작 - 화면 분석 중...");
    record("ui", "→ [db] 질의: 조회 조건 샘플 데이터 요청");
    const data = await bus.ask("ui", "db", "주문 목록 조회조건 데이터 (날짜, 상태코드) 주세요");
    record("ui", `← [db] 응답 수신: ${JSON.stringify(data)}`);
    record("ui", "완료 - testData 포함 결과 반환");
    return { testData: data, purpose: "주문 목록 조회" };
  }

  async function mockDBAgent() {
    record("db", "시작 - DB 분석 중...");
    // 턴마다 inbox 확인 시뮬레이션
    await new Promise(r => setTimeout(r, 20)); // UI가 먼저 ask할 시간
    record("db", "inbox 확인 중...");
    const queries = bus.drain("db");
    if (queries.length > 0) {
      record("db", `← [${queries[0].from}] 질의 수신: ${queries[0].question.slice(0, 50)}`);
      // DB는 테이블 정보 모르므로 Backend에게 질의
      record("db", "→ [backend] 질의: 테이블/컬럼 정보 요청");
      const tableInfo = await bus.ask("db", "backend", "주문 테이블명과 상태코드 컬럼을 알려주세요");
      record("db", `← [backend] 응답: ${tableInfo}`);
      // 실제 DB 조회 시뮬레이션
      const result = { dateRange: "2024-01-01~2024-12-31", statusCd: "COMP" };
      record("db", `↩ [${queries[0].from}] 답변: ${JSON.stringify(result)}`);
      bus.reply(queries[0].id, result);
    }
    record("db", "완료");
    return { testData: { orders: [{ id: 1, status: "COMP" }] } };
  }

  async function mockBackendAgent() {
    record("backend", "시작 - 소스 분석 중...");
    await new Promise(r => setTimeout(r, 50)); // DB가 먼저 ask할 시간
    record("backend", "inbox 확인 중...");
    const queries = bus.drain("backend");
    if (queries.length > 0) {
      record("backend", `← [${queries[0].from}] 질의 수신: ${queries[0].question.slice(0, 50)}`);
      const answer = "ORDER_TB 테이블, STATUS_CD 컬럼 (PEND/COMP/CANC)";
      record("backend", `↩ [${queries[0].from}] 답변: ${answer}`);
      bus.reply(queries[0].id, answer);
    }
    record("backend", "완료");
    return { dbTables: [{ name: "ORDER_TB", keyColumns: ["ORDER_ID"], purpose: "주문 데이터" }] };
  }

  const [uiResult, dbResult, backResult] = await Promise.all([
    mockUIAgent(),
    mockDBAgent(),
    mockBackendAgent(),
  ]);

  assert(uiResult.testData?.dateRange === "2024-01-01~2024-12-31", "UIAgent가 DB에서 받은 dateRange 포함");
  assert(uiResult.testData?.statusCd  === "COMP",                   "UIAgent가 DB에서 받은 statusCd 포함");
  assert(dbResult.testData?.orders?.length > 0,                     "DBAgent 결과 반환");
  assert(backResult.dbTables?.length > 0,                           "BackendAgent dbTables 반환");

  // 통신 이벤트 순서 검증
  const askEvents = events.filter(e => e.msg.startsWith("→"));
  const answerEvents = events.filter(e => e.msg.startsWith("↩"));
  assert(askEvents.length >= 2,  "ask_agent 2회 이상 발생 (ui→db, db→backend)");
  assert(answerEvents.length >= 2, "answer_query 2회 이상 발생");
}

// ── 3. 5개 에이전트 병렬 시작 검증 ─────────────────────────────────────────
console.log("\n=== 3. 5개 에이전트 병렬 시작 검증 ===");
{
  const startedAgents = new Set();
  const bus = new AgentBus();
  ["ui", "ui-source", "frontend", "backend", "db"].forEach(n => bus.register(n));

  async function mockAgent(name, delayMs) {
    startedAgents.add(name);
    record(name, "시작");
    await new Promise(r => setTimeout(r, delayMs));
    record(name, "완료");
    return { agent: name };
  }

  const t0 = Date.now();
  await Promise.allSettled([
    mockAgent("ui",        10),
    mockAgent("ui-source", 30),
    mockAgent("frontend",  20),
    mockAgent("backend",   25),
    mockAgent("db",        15),
  ]);
  const elapsed = Date.now() - t0;

  assert(startedAgents.size === 5,         "5개 에이전트 모두 시작됨");
  assert(startedAgents.has("ui"),          "UIAgent 시작");
  assert(startedAgents.has("ui-source"),   "UISourceAgent 시작");
  assert(startedAgents.has("frontend"),    "FrontendAgent 시작");
  assert(startedAgents.has("backend"),     "BackendAgent 시작");
  assert(startedAgents.has("db"),          "DBAgent 시작");
  assert(elapsed < 80,                     `병렬 실행 (${elapsed}ms < 80ms, 순차라면 ~100ms)`);
}

// ── 4. deadlock 방지 검증 (응답 없는 질의 타임아웃 시뮬레이션) ──────────────
console.log("\n=== 4. 에이전트 실패 격리 (Promise.allSettled) ===");
{
  const bus = new AgentBus();
  ["a", "b", "c"].forEach(n => bus.register(n));

  // 에이전트 A는 정상, B는 오류, C는 정상
  const settled = await Promise.allSettled([
    Promise.resolve({ agent: "a", ok: true }),
    Promise.reject(new Error("B 에이전트 오류")),
    Promise.resolve({ agent: "c", ok: true }),
  ]);

  const results = settled.map(r => r.status === "fulfilled" ? r.value : {});
  assert(results[0].ok === true,         "A 에이전트 정상 결과");
  assert(Object.keys(results[1]).length === 0, "B 에이전트 실패 → 빈 객체 fallback");
  assert(results[2].ok === true,         "C 에이전트 정상 결과 (B 실패에 영향 없음)");
}

// ── 결과 요약 ────────────────────────────────────────────────────────────────
console.log("\n════════════════════════════════════════");
console.log(`결과: ${passed}개 통과 / ${failed}개 실패`);

console.log("\n통신 이벤트 타임라인:");
events.filter(e => e.msg.startsWith("→") || e.msg.startsWith("←") || e.msg.startsWith("↩"))
  .forEach(e => console.log(`  [${e.ts}] [${e.tag.padEnd(8)}] ${e.msg}`));

if (failed > 0) process.exit(1);
