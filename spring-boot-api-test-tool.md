# Spring Boot / MyBatis API 테스트 툴 — 상세 개발 계획

> 현재 Puppeteer 기반 UI 테스트 툴과 동일한 **녹화(Record) → 리플레이(Replay)** 패턴을  
> Spring Boot / MyBatis 백엔드 계층에 적용한 API 회귀 테스트 도구.  
> **트리거 방식: HTTP 헤더 대신 자바 메서드 호출**로 녹화/리플레이 세션을 제어한다.

---

## 1. 개요

### 1.1 목표

| 항목 | 내용 |
|------|------|
| **녹화** | `TestRecorder.record(name, () → target())` 호출로 세션 시작 → MyBatis 쿼리·결과 전체 저장 |
| **리플레이** | `TestReplayer.replay(caseId, () → target())` 호출 → DB 쿼리를 mock으로 대체, 결과 검증 |
| **비교** | 메서드 반환값 JSON diff + 실행된 SQL 목록·순서 비교 |
| **관리 UI** | 웹 대시보드에서 케이스 관리, 결과 확인, 수동 실행 |

### 1.2 핵심 변경 — HTTP 트리거 → 메서드 트리거

| 구분 | 기존 설계 (폐기) | 신규 설계 |
|------|-----------------|-----------|
| 녹화 시작 | HTTP 요청에 `X-Test-Mode: record` 헤더 | `TestRecorder.record("이름", () → ...)` |
| 리플레이 시작 | HTTP 요청에 `X-Test-Mode: replay` 헤더 | `TestReplayer.replay(id, () → ...)` |
| 세션 생명주기 | Servlet Filter (Request → Response 범위) | 람다 블록 범위 (try-with-resources 또는 콜백) |
| Servlet Filter | 필수 (ContentCachingRequestWrapper) | **불필요** — 완전 제거 |
| 적용 범위 | HTTP Controller 이상만 커버 | **Service / Mapper 계층 직접** 커버 |

### 1.3 핵심 가치

- **DB 없이 테스트**: 녹화된 쿼리 결과를 재주입하므로 실제 DB 연결 불필요
- **계층 독립**: Controller / HTTP 서버 없이 Service·Mapper 레벨만 테스트 가능
- **환경 독립성**: 로컬·개발·스테이징 환경 구분 없이 동일 케이스 재사용
- **SQL 회귀 감지**: 쿼리 변경(추가/삭제/수정)을 자동으로 탐지
- **JUnit 자연 통합**: `@Test` 메서드 안에서 바로 호출 가능, 추가 HTTP 서버 불필요

---

## 2. 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│  테스트 코드 (JUnit / 스크립트 / 관리 UI 내 실행 버튼)            │
│                                                                 │
│  TestRecorder.record("케이스명", () -> {                         │
│      userService.getUser(42L);   ← 녹화 대상 메서드             │
│  });                                                            │
│                                                                 │
│  TestReplayer.replay(caseId, () -> {                            │
│      userService.getUser(42L);   ← 동일 호출                    │
│  });                                                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ ThreadLocal 세션 주입
┌──────────────────────────▼──────────────────────────────────────┐
│  Spring Boot Application                                        │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Service → Mapper                                       │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                         │ SqlSession.query / update             │
│  ┌──────────────────────▼──────────────────────────────────┐    │
│  │  QueryRecordingInterceptor  (MyBatis Plugin)            │    │
│  │                                                         │    │
│  │  [녹화 모드]  실제 DB 실행 → SQL + params + result 저장   │    │
│  │  [리플레이]   SQL 매칭 후 저장된 result 반환, DB 미접속   │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐    │
│  │  RecordingStore  (SQLite)                               │    │
│  │  - test_cases, query_logs, run_history 테이블           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Management REST API  (/api/test/*)  + 관리 UI          │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 기술 스택

| 영역 | 선택 | 이유 |
|------|------|------|
| 프레임워크 | Spring Boot 3.x | 기존 서버와 동일 환경 |
| SQL 인터셉터 | MyBatis `Interceptor` (`@Intercepts`) | 쿼리 실행 최하위 진입점 |
| 세션 제어 | `TestRecorder` / `TestReplayer` (정적 API) | 메서드 호출로 직접 제어 |
| 세션 격리 | `ThreadLocal<RecordingSession>` | 멀티스레드 환경에서 요청별 격리 |
| 저장소 | SQLite (`sqlite-jdbc`) | 단일 파일, 외부 의존 없음 |
| 직렬화 | Jackson `ObjectMapper` | 기존 Spring 스택 재사용 |
| 관리 API | Spring MVC REST (`/api/test/*`) | 기존 서버에 통합 |
| 관리 UI | React (Vite) 또는 Thymeleaf | 별도 선택 가능 |
| CI 실행 | JUnit 5 Extension | 파이프라인 통합 |

---

## 4. 데이터 모델

### 4.1 SQLite 스키마

```sql
-- 테스트 케이스 (녹화 단위)
CREATE TABLE test_cases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',
  tags           TEXT    NOT NULL DEFAULT '[]',    -- JSON 배열
  target_class   TEXT    NOT NULL,                 -- com.example.UserService
  target_method  TEXT    NOT NULL,                 -- getUser
  method_args    TEXT    NOT NULL DEFAULT '[]',    -- 직렬화된 파라미터 JSON
  method_result  TEXT,                             -- 직렬화된 반환값 JSON (null 가능)
  created_at     TEXT    NOT NULL
);

-- 케이스별 쿼리 로그 (순서 중요)
CREATE TABLE query_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,               -- 실행 순서 (0-based)
  mapper_id    TEXT    NOT NULL,               -- com.example.UserMapper.findById
  sql_template TEXT    NOT NULL,               -- 바인딩 전 SQL (? 포함)
  params       TEXT    NOT NULL DEFAULT '{}',  -- 바인딩 파라미터 JSON
  result       TEXT,                           -- 직렬화된 결과 JSON
  row_count    INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);

-- 실행 이력
CREATE TABLE run_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      INTEGER NOT NULL REFERENCES test_cases(id),
  run_at       TEXT    NOT NULL,
  mode         TEXT    NOT NULL,               -- mock | live
  result_pass  INTEGER NOT NULL DEFAULT 0,     -- 반환값 일치 여부
  sql_pass     INTEGER NOT NULL DEFAULT 0,     -- SQL 목록 일치 여부
  result_diffs TEXT    NOT NULL DEFAULT '[]',  -- JSON diff 목록
  sql_diffs    TEXT    NOT NULL DEFAULT '[]',  -- SQL 변경 목록
  duration_ms  INTEGER NOT NULL DEFAULT 0
);
```

### 4.2 쿼리 로그 결과 예시

```json
{
  "seq": 0,
  "mapperId": "com.example.mapper.UserMapper.findById",
  "sqlTemplate": "SELECT * FROM users WHERE id = ?",
  "params": { "0": 42 },
  "result": [{ "id": 42, "name": "홍길동", "email": "hong@example.com" }],
  "rowCount": 1,
  "durationMs": 3
}
```

---

## 5. 핵심 컴포넌트 상세 설계

### 5.1 TestRecorder — 녹화 API

**역할**: 메서드 호출로 녹화 세션을 시작·종료하고 SQLite에 저장한다.

```java
public final class TestRecorder {

    private final TestCaseStore store;

    // ── 람다 방식 (권장) ──
    public <T> T record(String name, Callable<T> target) throws Exception {
        RecordingSession session = new RecordingSession("record", name);
        RecordingContext.set(session);
        try {
            T result = target.call();
            session.captureResult(result);
            store.save(session);         // SQLite 저장
            return result;
        } finally {
            RecordingContext.clear();
        }
    }

    // void 대상용
    public void recordVoid(String name, ThrowingRunnable target) throws Exception {
        record(name, () -> { target.run(); return null; });
    }

    // ── 수동 방식 (여러 메서드 호출을 하나의 케이스로 묶을 때) ──
    public RecordingHandle startRecording(String name) {
        RecordingSession session = new RecordingSession("record", name);
        RecordingContext.set(session);
        return new RecordingHandle(session, store);
    }
}

// 수동 방식 사용 예
RecordingHandle h = recorder.startRecording("주문 생성 플로우");
try {
    userService.getUser(42L);
    orderService.createOrder(42L, items);
} finally {
    h.close();  // AutoCloseable → try-with-resources 사용 가능
}
```

**사용 예시**:
```java
@Autowired TestRecorder recorder;

// 단순 단일 메서드 녹화
recorder.record("사용자 조회 - 정상", () ->
    userService.getUser(42L));

// 복합 플로우 녹화
try (RecordingHandle h = recorder.startRecording("주문 생성 플로우")) {
    UserDto user  = userService.getUser(42L);
    OrderDto order = orderService.createOrder(user.getId(), items);
}
```

---

### 5.2 TestReplayer — 리플레이 API

**역할**: 저장된 케이스를 로드하고 mock 모드로 동일 메서드를 실행, 결과를 비교한다.

```java
public final class TestReplayer {

    private final TestCaseStore store;
    private final JsonDiff jsonDiff;

    // ── 람다 방식 (권장) ──
    public <T> ReplayResult replay(long caseId, Callable<T> target) throws Exception {
        TestCase recorded = store.findById(caseId);
        RecordingSession session = RecordingSession.forReplay(recorded);
        RecordingContext.set(session);
        try {
            T actualResult = target.call();
            return compare(recorded, actualResult, session);
        } finally {
            RecordingContext.clear();
        }
    }

    // ── 수동 방식 ──
    public ReplayHandle startReplay(long caseId) {
        TestCase recorded = store.findById(caseId);
        RecordingSession session = RecordingSession.forReplay(recorded);
        RecordingContext.set(session);
        return new ReplayHandle(recorded, session, this);
    }

    private ReplayResult compare(TestCase recorded, Object actual, RecordingSession session) {
        List<String> resultDiffs = jsonDiff.compare(recorded.getMethodResult(),
                                                     serialize(actual));
        List<String> sqlDiffs    = SqlDiff.compare(recorded.getQueryLogs(),
                                                    session.getExecutedLogs());
        return ReplayResult.of(resultDiffs, sqlDiffs, session.hasSqlMismatch());
    }
}
```

**사용 예시**:
```java
@Autowired TestReplayer replayer;

// 단순 리플레이
ReplayResult r = replayer.replay(1L, () -> userService.getUser(42L));
r.assertPassed(); // 실패 시 JUnit assertion 에러

// 반환값 사용하면서 리플레이
ReplayResult r2 = replayer.replay(1L, () -> {
    UserDto user = userService.getUser(42L);
    assertThat(user.getName()).isEqualTo("홍길동");
    return user;
});

// 복합 플로우 리플레이
try (ReplayHandle h = replayer.startReplay(2L)) {
    userService.getUser(42L);
    orderService.createOrder(42L, items);
    ReplayResult r = h.finish();
    r.assertPassed();
}
```

---

### 5.3 RecordingContext — ThreadLocal 세션 보관

```java
public final class RecordingContext {

    private static final ThreadLocal<RecordingSession> HOLDER = new ThreadLocal<>();

    public static void set(RecordingSession session) { HOLDER.set(session); }
    public static RecordingSession get()             { return HOLDER.get(); }
    public static void clear()                       { HOLDER.remove(); }
    public static boolean isActive()                 { return HOLDER.get() != null; }
}
```

---

### 5.4 QueryRecordingInterceptor — MyBatis Plugin

**역할**: MyBatis 쿼리 실행을 인터셉트하여 녹화 또는 mock 주입을 수행한다.  
`RecordingContext.get()`이 null이면 완전 투명하게 통과 — 일반 요청에 **zero overhead**.

```java
@Intercepts({
  @Signature(type = Executor.class, method = "query",
             args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
  @Signature(type = Executor.class, method = "query",
             args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class,
                     CacheKey.class, BoundSql.class}),
  @Signature(type = Executor.class, method = "update",
             args = {MappedStatement.class, Object.class})
})
@Component
public class QueryRecordingInterceptor implements Interceptor {

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        RecordingSession session = RecordingContext.get();
        if (session == null) return invocation.proceed(); // 일반 요청: 투명 통과

        MappedStatement ms        = (MappedStatement) invocation.getArgs()[0];
        Object parameter          = invocation.getArgs()[1];
        BoundSql boundSql         = ms.getBoundSql(parameter);
        String sqlTemplate        = SqlNormalizer.normalize(boundSql.getSql());
        Map<String, Object> params = extractParams(ms, parameter, boundSql);

        if (session.isRecording()) {
            // ── 실제 DB 실행 후 결과 저장 ──
            long start  = System.currentTimeMillis();
            Object result = invocation.proceed();
            long elapsed  = System.currentTimeMillis() - start;

            session.addQueryLog(QueryLog.builder()
                .seq(session.nextSeq())
                .mapperId(ms.getId())
                .sqlTemplate(sqlTemplate)
                .params(params)
                .result(serialize(result))
                .rowCount(countRows(result))
                .durationMs(elapsed)
                .build());

            return result;

        } else { // 리플레이 모드
            // ── DB 미접속, 저장된 결과 반환 ──
            QueryLog recorded = session.pollExpectedQuery(sqlTemplate, ms.getId());
            if (recorded == null) {
                session.markSqlMismatch("예상치 못한 쿼리: " + sqlTemplate);
                return invocation.proceed(); // fallback: 실제 실행
            }
            return deserializeResult(recorded.getResult(), invocation);
        }
    }
}
```

---

### 5.5 SQL 매칭 전략

리플레이 시 녹화된 쿼리와 실행 쿼리를 매칭하는 로직:

```
1. SQL 정규화 (SqlNormalizer.normalize)
   - 연속 공백 → 단일 스페이스
   - 대소문자 통일 (소문자 기준)
   - 줄바꿈 제거
   - IN (?, ?, ?) → IN (?) 와일드카드 처리 (동적 SQL 대응)

2. 순서 기반 매칭 (positional matching)
   - 같은 SQL이 N번 실행되면 순서대로 소비
   - UserMapper.findById가 3번 실행 → 녹화된 [r1, r2, r3] 순서 반환

3. Mapper ID 보조 매칭
   - SQL이 같아도 mapperId가 다르면 별도 취급
   - 예: UserMapper.count vs OrderMapper.count (같은 SELECT COUNT(*))

4. 파라미터 허용 오차 (선택적)
   - strictParams = true: 파라미터까지 비교
   - 기본: SQL 구조만 비교
```

---

### 5.6 ReplayResult — 비교 결과

```java
public class ReplayResult {
    private final boolean resultPass;   // 반환값 일치
    private final boolean sqlPass;      // SQL 목록·순서 일치
    private final List<String> resultDiffs;
    private final List<String> sqlDiffs;
    private final long durationMs;

    public boolean isPassed() { return resultPass && sqlPass; }

    // JUnit assert 헬퍼
    public void assertPassed() {
        if (!isPassed()) {
            throw new AssertionError("Replay failed:\n"
                + "Result diffs: " + resultDiffs + "\n"
                + "SQL diffs:    " + sqlDiffs);
        }
    }

    // 세분화 검증
    public void assertResultPassed() { ... }
    public void assertSqlPassed()    { ... }
}
```

**비교 결과 JSON (run_history 저장)**:
```json
{
  "caseId": 1,
  "runAt": "2026-05-07T10:00:00",
  "resultPass": false,
  "sqlPass": true,
  "resultDiffs": [
    "root.data.count: 5 → 6",
    "root.data.items[2].name: 기존이름 → 새이름"
  ],
  "sqlDiffs": [],
  "durationMs": 38
}
```

---

## 6. 관리 REST API

관리 UI와 CI 스크립트를 위한 별도 엔드포인트. 실제 서비스 API와 무관.

| Method | Path | 설명 |
|--------|------|------|
| `GET`    | `/api/test/cases` | 케이스 목록 (태그 필터 지원) |
| `GET`    | `/api/test/cases/{id}` | 케이스 상세 (쿼리 로그 포함) |
| `POST`   | `/api/test/cases/{id}/replay` | 특정 케이스 리플레이 실행 |
| `POST`   | `/api/test/suite` | 다수 케이스 일괄 실행 |
| `PATCH`  | `/api/test/cases/{id}` | 케이스 이름/설명/태그 수정 |
| `DELETE` | `/api/test/cases/{id}` | 케이스 삭제 |
| `GET`    | `/api/test/cases/{id}/history` | 실행 이력 조회 |
| `GET`    | `/api/test/export/{id}` | 케이스 JSON 내보내기 |
| `POST`   | `/api/test/import` | 케이스 JSON 가져오기 |

> 관리 API에서 replay를 실행할 때는 `TestReplayer`를 직접 빈으로 주입받아 호출한다.  
> 이때 `target_class` + `target_method` + `method_args`를 이용해 리플렉션으로 재호출한다.

### 6.1 관리 UI 내 자동 리플레이 (리플렉션 기반)

관리 UI에서 "재생" 버튼 클릭 시 서버가 리플렉션으로 동일 메서드를 재호출:

```java
// TestCaseController.java
@PostMapping("/cases/{id}/replay")
public ReplayResult replayFromUi(@PathVariable long id) {
    TestCase tc = store.findById(id);
    Class<?> clazz  = Class.forName(tc.getTargetClass());
    Object   bean   = applicationContext.getBean(clazz);
    Method   method = findMethod(clazz, tc.getTargetMethod(), tc.getMethodArgs());
    Object[] args   = deserializeArgs(tc.getMethodArgs(), method);

    return replayer.replay(id, () -> method.invoke(bean, args));
}
```

---

## 7. 개발 단계별 계획

### Phase 1 — 핵심 녹화 (2~3일)

- [ ] `RecordingSession`, `RecordingContext` (ThreadLocal) 구현
- [ ] `QueryRecordingInterceptor` 구현 (query/update intercept)
- [ ] `TestRecorder` 람다·수동 API 구현
- [ ] SQLite 스키마 생성 + `TestCaseStore` CRUD
- [ ] 수동 테스트: `recorder.record("케이스명", () → service.method())` → DB 확인

### Phase 2 — 리플레이 + Mock 주입 (3~4일)

- [ ] `QueryRecordingInterceptor` mock 분기 구현
- [ ] `SqlNormalizer.normalize()` 구현
- [ ] 순서 기반 쿼리 매칭 (`pollExpectedQuery`)
- [ ] `ResultSet` 역직렬화 (List → ResultSet 변환)
- [ ] `TestReplayer` 람다·수동 API + `ReplayResult` 구현
- [ ] 수동 테스트: `replayer.replay(1L, () → service.method())`

### Phase 3 — 비교 로직 (2일)

- [ ] 반환값 JSON diff (`JsonDiff.compare`)
- [ ] SQL 목록 순서 diff (`SqlDiff.compare`)
- [ ] `run_history` 저장
- [ ] `--ignore-field` 정규식, `strictParams` 옵션 지원

### Phase 4 — 관리 API + UI (3~4일)

- [ ] REST API 9개 엔드포인트 구현
- [ ] 리플렉션 기반 관리 UI 재실행 (`TestCaseController.replayFromUi`)
- [ ] 관리 UI 구현:
  - 케이스 목록 (이름, 클래스, 메서드, 마지막 실행 결과)
  - 케이스 상세: 파라미터 + 쿼리 로그 펼치기
  - 실행 버튼 + 결과 패널
  - 이력 타임라인

### Phase 5 — JUnit 5 통합 (1~2일)

- [ ] `ApiTestExtension` — `@ApiReplay(id)` → 자동 mock 주입 + assert
- [ ] `@ApiRecord(name)` — 테스트 실행 시 자동 녹화
- [ ] JUnit XML 리포트 출력
- [ ] 환경변수 기반 설정 (`API_TEST_DB_PATH`, `API_TEST_STRICT_PARAMS`)

---

## 8. 주요 엣지케이스 및 해결 전략

| 상황 | 문제 | 해결 |
|------|------|------|
| **같은 SQL 반복** | `SELECT * WHERE id=?` 가 3번 실행 | 순서 기반 큐 소비 (`pollExpectedQuery`) |
| **동적 SQL** | `<foreach>` 로 파라미터 수에 따라 SQL 변형 | `IN (?, ?, ?)` → `IN (?)` 와일드카드 정규화 |
| **Auto-increment ID** | INSERT 후 생성된 ID가 다름 | `useGeneratedKeys` 결과는 실제값 반환, ID 필드 비교 제외 옵션 |
| **트랜잭션 롤백** | 리플레이 중 실제 DB write 방지 | mock 모드에서 `update` intercept → 녹화된 row count 반환, 실 DB 미전송 |
| **멀티스레드** | 동시 호출 시 쿼리 로그 혼재 | `ThreadLocal<RecordingSession>` 으로 호출별 완전 격리 |
| **날짜/시간 필드** | `created_at` 같은 동적 필드 diff 발생 | `ignoreFields` 패턴으로 비교 제외 |
| **복합 플로우** | 여러 Service 메서드를 하나의 케이스로 | `startRecording()` / `close()` 수동 범위 제어 |
| **대용량 ResultSet** | 수천 row의 result 직렬화 | `maxResultSize` 설정으로 저장 row 수 제한 (기본 1,000) |
| **binary/BLOB 컬럼** | 직렬화 불가 | Base64 인코딩 후 저장, 비교 시 제외 처리 |
| **리플렉션 재호출 실패** | 관리 UI에서 재실행 시 인자 타입 불일치 | 인자 타입 정보를 `method_args_types`에 함께 저장 |

---

## 9. 설정 (application.yml)

```yaml
api-test:
  enabled: true                   # 전체 기능 활성화
  db-path: ./test-recordings.db   # SQLite 파일 경로
  strict-params: false            # 파라미터까지 SQL 매칭에 사용
  max-result-size: 1000           # ResultSet 저장 최대 row 수
  ignore-fields:                  # 비교 제외 JSON 경로 (정규식)
    - ".*\\.created_at"
    - ".*\\.updated_at"
    - ".*\\.timestamp"
  ignore-sql-params: false        # SQL 파라미터 무시 (SQL 구조만 비교)
  management-path: /api/test      # 관리 API prefix
```

---

## 10. 프로젝트 구조

```
src/main/java/com/example/apitest/
├── config/
│   └── ApiTestConfig.java             # 자동구성, @ConditionalOnProperty
├── core/
│   ├── RecordingSession.java          # 단일 녹화/리플레이 세션
│   ├── RecordingContext.java          # ThreadLocal 보관
│   ├── RecordingHandle.java           # AutoCloseable 수동 제어 핸들
│   ├── ReplayHandle.java              # 복합 플로우 리플레이 핸들
│   ├── ReplayResult.java              # 비교 결과 + JUnit assert 헬퍼
│   └── QueryLog.java                  # 쿼리 로그 VO
├── api/
│   ├── TestRecorder.java              # 녹화 진입점 (메서드 호출 트리거)
│   └── TestReplayer.java              # 리플레이 진입점 (메서드 호출 트리거)
├── interceptor/
│   ├── QueryRecordingInterceptor.java # MyBatis Plugin
│   └── SqlNormalizer.java             # SQL 정규화 유틸
├── store/
│   ├── TestCaseStore.java             # SQLite CRUD
│   └── schema.sql                     # DDL
├── compare/
│   ├── JsonDiff.java                  # 반환값 JSON diff
│   └── SqlDiff.java                   # SQL 목록 diff
├── web/
│   ├── TestCaseController.java        # 관리 REST API
│   └── dto/                           # 요청/응답 DTO
└── junit/
    ├── ApiTestExtension.java          # JUnit 5 Extension
    ├── ApiRecord.java                 # @ApiRecord 어노테이션
    └── ApiReplay.java                 # @ApiReplay 어노테이션
```

---

## 11. JUnit 5 통합 사용 예시

```java
@SpringBootTest
class UserServiceTest {

    @Autowired TestRecorder recorder;
    @Autowired TestReplayer replayer;
    @Autowired UserService  userService;

    // ── 녹화 ──
    @Test
    void recordGetUser() throws Exception {
        recorder.record("사용자 조회 - 정상",
            () -> userService.getUser(42L));
        // 완료 후 콘솔에 case_id 출력 → 리플레이 때 사용
    }

    // ── 리플레이 (어노테이션 방식) ──
    @Test
    @ExtendWith(ApiTestExtension.class)
    @ApiReplay(id = 1)
    void replayGetUser() {
        // ApiTestExtension이 자동으로 mock 설정 + 검증
        userService.getUser(42L);
    }

    // ── 리플레이 (수동 방식) ──
    @Test
    void replayGetUserManual() throws Exception {
        ReplayResult r = replayer.replay(1L,
            () -> userService.getUser(42L));

        assertThat(r.isPassed()).isTrue();
        // 또는 세분화:
        r.assertResultPassed();  // 반환값만 검증
        r.assertSqlPassed();     // SQL만 검증
    }

    // ── 복합 플로우 녹화 ──
    @Test
    void recordOrderFlow() throws Exception {
        try (RecordingHandle h = recorder.startRecording("주문 생성 플로우")) {
            UserDto  user  = userService.getUser(42L);
            OrderDto order = orderService.createOrder(user.getId(), items);
        }
    }
}
```

---

## 12. 개발 우선순위 요약

```
Phase 1 (핵심 녹화)       ████████░░  필수
Phase 2 (리플레이)         ████████░░  필수
Phase 3 (비교 로직)        ██████░░░░  필수
Phase 4 (관리 UI)          ████░░░░░░  권장
Phase 5 (JUnit Extension)  ██░░░░░░░░  선택

전체 예상: 10~13 개발일
```

---

## 13. 현재 Puppeteer 툴과 대응 관계

| Puppeteer 툴 | Spring Boot 툴 |
|---|---|
| `inject.js` (이벤트 캡처) | `QueryRecordingInterceptor` (쿼리 캡처) |
| `start-recording` WS 메시지 | `TestRecorder.startRecording()` / `record()` |
| `stop-recording` WS 메시지 | `RecordingHandle.close()` |
| `start-replay` WS 메시지 | `TestReplayer.startReplay()` / `replay()` |
| `mockMap` (URL → 응답 매핑) | `session.pollExpectedQuery()` (SQL → 결과 매핑) |
| `canonicalUrl()` (URL 정규화) | `SqlNormalizer.normalize()` (SQL 정규화) |
| `jsonDiff()` (응답 비교) | `JsonDiff.compare()` (동일 로직 Java 이식) |
| `recordings.db` SQLite | `test-recordings.db` SQLite |
| 관리 웹 UI (WebSocket) | 관리 웹 UI (REST) |
| `run-tests.js` CLI | JUnit 5 Extension + `@ApiReplay` |
