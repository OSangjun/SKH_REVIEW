# Spring Boot / MyBatis API 테스트 툴 — 상세 개발 계획

> 현재 Puppeteer 기반 UI 테스트 툴과 동일한 **녹화(Record) → 리플레이(Replay)** 패턴을  
> Spring Boot / MyBatis 백엔드 계층에 적용한 API 회귀 테스트 도구.

---

## 1. 개요

### 1.1 목표

| 항목 | 내용 |
|------|------|
| **녹화** | API 요청 → Service 처리 → MyBatis 쿼리·결과 전체를 세션 단위로 저장 |
| **리플레이** | 동일한 API 요청 재전송, DB 쿼리를 mock으로 대체해 처리 결과 검증 |
| **비교** | API 응답 JSON diff + 실행된 SQL 목록·순서 비교 |
| **관리 UI** | 웹 대시보드에서 케이스 관리, 결과 확인, 수동 실행 |

### 1.2 핵심 가치

- **DB 없이 테스트**: 녹화된 쿼리 결과를 재주입하므로 실제 DB 연결 불필요
- **환경 독립성**: 로컬·개발·스테이징 환경 구분 없이 동일한 케이스 재사용
- **SQL 회귀 감지**: 쿼리 변경(추가/삭제/수정)을 자동으로 탐지

---

## 2. 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│  테스트 클라이언트 (curl / Postman / CI 스크립트)               │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP 요청
┌──────────────────────────▼──────────────────────────────────────┐
│  Spring Boot Application                                        │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  RecordingFilter  (Servlet Filter)                      │    │
│  │  - 요청/응답 body 복사·저장                               │    │
│  │  - ThreadLocal에 RecordingSession 생성                   │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                         │                                       │
│  ┌──────────────────────▼──────────────────────────────────┐    │
│  │  Controller → Service → Mapper                          │    │
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
│  │  Management REST API  (/api/test/*)                     │    │
│  │  + 관리 UI  (React or Thymeleaf)                        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 기술 스택

| 영역 | 선택 | 이유 |
|------|------|------|
| 프레임워크 | Spring Boot 3.x | 기존 서버와 동일 환경 |
| SQL 인터셉터 | MyBatis `Interceptor` (`@Intercepts`) | 쿼리 실행 최하위 진입점 |
| 요청 캡처 | Servlet `Filter` + `ContentCachingRequestWrapper` | body 재읽기 가능 |
| 저장소 | SQLite (`sqlite-jdbc`) | 단일 파일, 외부 의존 없음 |
| 직렬화 | Jackson `ObjectMapper` | 기존 Spring 스택 재사용 |
| 관리 API | Spring MVC REST (`/api/test/*`) | 기존 서버에 통합 |
| 관리 UI | React (Vite) 또는 Thymeleaf | 별도 선택 가능 |
| CI 실행 | CLI (`java -jar`) 또는 JUnit 5 Extension | 파이프라인 통합 |

---

## 4. 데이터 모델

### 4.1 SQLite 스키마

```sql
-- 테스트 케이스 (녹화 단위)
CREATE TABLE test_cases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  tags         TEXT    NOT NULL DEFAULT '[]',   -- JSON 배열
  method       TEXT    NOT NULL,                -- GET/POST/PUT/DELETE
  path         TEXT    NOT NULL,                -- /api/users/1
  req_headers  TEXT    NOT NULL DEFAULT '{}',   -- JSON
  req_body     TEXT,                            -- JSON or null
  resp_status  INTEGER NOT NULL,
  resp_headers TEXT    NOT NULL DEFAULT '{}',
  resp_body    TEXT,
  created_at   TEXT    NOT NULL
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
  resp_pass    INTEGER NOT NULL DEFAULT 0,     -- 응답 일치 여부
  sql_pass     INTEGER NOT NULL DEFAULT 0,     -- SQL 목록 일치 여부
  resp_diffs   TEXT    NOT NULL DEFAULT '[]',  -- JSON diff 목록
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

### 5.1 RecordingFilter (Servlet Filter)

**역할**: HTTP 요청/응답을 가로채어 body를 캡처하고 쿼리 로그와 묶는다.

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RecordingFilter implements Filter {

    private final RecordingContext context;  // ThreadLocal 보관자
    private final TestCaseStore store;

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) {
        ContentCachingRequestWrapper  wrappedReq = new ContentCachingRequestWrapper((HttpServletRequest) req);
        ContentCachingResponseWrapper wrappedRes = new ContentCachingResponseWrapper((HttpServletResponse) res);

        String mode = wrappedReq.getHeader("X-Test-Mode"); // "record" | "replay"
        if (mode == null) {
            chain.doFilter(wrappedReq, wrappedRes);
            wrappedRes.copyBodyToResponse();
            return;
        }

        RecordingSession session = new RecordingSession(mode);
        context.set(session);
        try {
            chain.doFilter(wrappedReq, wrappedRes);
            wrappedRes.copyBodyToResponse();

            if ("record".equals(mode)) {
                store.save(buildTestCase(wrappedReq, wrappedRes, session));
            } else if ("replay".equals(mode)) {
                store.saveRunHistory(compare(wrappedReq, wrappedRes, session));
            }
        } finally {
            context.clear();
        }
    }
}
```

**요청 헤더 규격**:
| 헤더 | 값 | 설명 |
|---|---|---|
| `X-Test-Mode` | `record` \| `replay` | 동작 모드 |
| `X-Test-Case-Id` | `{id}` | 리플레이 시 비교 대상 케이스 ID |
| `X-Test-Case-Name` | `{name}` | 녹화 시 케이스 이름 |

---

### 5.2 QueryRecordingInterceptor (MyBatis Plugin)

**역할**: MyBatis 쿼리 실행을 인터셉트하여 녹화 또는 mock 주입을 수행한다.

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

    private final RecordingContext context;

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        RecordingSession session = context.get();
        if (session == null) return invocation.proceed(); // 일반 요청 통과

        MappedStatement ms = (MappedStatement) invocation.getArgs()[0];
        Object parameter  = invocation.getArgs()[1];
        BoundSql boundSql = ms.getBoundSql(parameter);

        String sqlTemplate = normalizeSql(boundSql.getSql());
        Map<String, Object> params = extractParams(ms, parameter, boundSql);

        if ("record".equals(session.getMode())) {
            // ── 실제 실행 후 결과 저장 ──
            long start = System.currentTimeMillis();
            Object result = invocation.proceed();
            long duration = System.currentTimeMillis() - start;

            session.addQueryLog(QueryLog.builder()
                .seq(session.nextSeq())
                .mapperId(ms.getId())
                .sqlTemplate(sqlTemplate)
                .params(params)
                .result(serializeResult(result))
                .rowCount(countRows(result))
                .durationMs(duration)
                .build());

            return result;

        } else { // replay
            // ── DB 미접속, 저장된 결과 반환 ──
            QueryLog recorded = session.pollExpectedQuery(sqlTemplate, params);
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

### 5.3 SQL 매칭 전략

리플레이 시 녹화된 쿼리와 실행 쿼리를 매칭하는 로직:

```
1. SQL 정규화 (normalizeSql)
   - 연속 공백 → 단일 스페이스
   - 대소문자 통일 (SELECT → SELECT)
   - 줄바꿈 제거

2. 순서 기반 매칭 (positional matching)
   - 같은 SQL이 N번 실행되면 순서대로 소비
   - UserMapper.findById 가 3번 실행 → 녹화된 [result1, result2, result3] 순서 반환

3. Mapper ID 보조 매칭
   - SQL 정규화가 같아도 mapperId 가 다르면 별도 취급
   - 예: UserMapper.count vs OrderMapper.count (같은 SELECT COUNT(*) 쿼리)

4. 파라미터 허용 오차 (선택적)
   - --strict-params 옵션: 파라미터까지 비교
   - 기본: SQL 구조만 비교 (파라미터는 무시)
```

---

### 5.4 비교 로직

```
녹화된 케이스              리플레이 실행결과
────────────               ──────────────────
resp_status: 200     vs    실제 응답 status
resp_body: {...}     vs    실제 응답 body  → jsonDiff()
                           
query_logs[0~N]      vs    실행된 query_logs[0~N]
  - SQL 목록 순서 비교
  - SQL 추가/제거/변경 감지
  - row_count 변화 감지 (선택적)
```

**비교 결과 구조**:
```json
{
  "caseId": 42,
  "runAt": "2026-05-07T10:00:00",
  "respPass": false,
  "sqlPass": true,
  "respDiffs": [
    "root.data.count: 5 → 6",
    "root.data.items[2].name: 기존이름 → 새이름"
  ],
  "sqlDiffs": [],
  "durationMs": 38
}
```

---

## 6. 관리 REST API

| Method | Path | 설명 |
|--------|------|------|
| `GET`  | `/api/test/cases` | 케이스 목록 |
| `GET`  | `/api/test/cases/{id}` | 케이스 상세 (쿼리 로그 포함) |
| `POST` | `/api/test/cases/{id}/replay` | 특정 케이스 리플레이 실행 |
| `POST` | `/api/test/suite` | 다수 케이스 일괄 실행 |
| `DELETE` | `/api/test/cases/{id}` | 케이스 삭제 |
| `GET`  | `/api/test/cases/{id}/history` | 실행 이력 조회 |
| `GET`  | `/api/test/export/{id}` | 케이스 JSON 내보내기 |
| `POST` | `/api/test/import` | 케이스 JSON 가져오기 |

---

## 7. 개발 단계별 계획

### Phase 1 — 핵심 녹화 (2~3일)

- [ ] `RecordingSession`, `RecordingContext` (ThreadLocal) 구현
- [ ] `ContentCachingRequestWrapper` 기반 `RecordingFilter` 구현
- [ ] `QueryRecordingInterceptor` 구현 (query/update intercept)
- [ ] SQLite 스키마 생성 + `TestCaseStore` CRUD
- [ ] 수동 테스트: `X-Test-Mode: record` 헤더로 요청 → DB 확인

### Phase 2 — 리플레이 + Mock 주입 (3~4일)

- [ ] `QueryRecordingInterceptor` mock 분기 구현
- [ ] SQL 정규화 함수 (`normalizeSql`)
- [ ] 순서 기반 쿼리 매칭 (`pollExpectedQuery`)
- [ ] `ResultSet` 역직렬화 (List→ResultSet 변환)
- [ ] `RecordingFilter`에서 리플레이 모드 비교 로직 연결
- [ ] 수동 테스트: `X-Test-Mode: replay`, `X-Test-Case-Id: 1`

### Phase 3 — 비교 로직 (2일)

- [ ] API 응답 JSON diff (현재 툴의 `jsonDiff` Java 이식)
- [ ] SQL 목록 순서 diff (추가/삭제/변경 감지)
- [ ] `run_history` 저장
- [ ] 파라미터 무시 옵션 / `--ignore-body` 정규식 지원

### Phase 4 — 관리 API + UI (3~4일)

- [ ] REST API 7개 엔드포인트 구현
- [ ] 관리 UI 구현:
  - 케이스 목록 (이름, URL, 태그, 마지막 실행 결과)
  - 케이스 상세: API 정보 + 쿼리 로그 펼치기
  - 실행 버튼 + 결과 패널
  - 이력 타임라인

### Phase 5 — CI/CD 통합 (1~2일)

- [ ] CLI runner: `java -jar tester.jar --all --base-url http://staging`
- [ ] JUnit 5 Extension (`@ApiTestCase`, `@ApiTestSuite`)
- [ ] JUnit XML 리포트 출력
- [ ] 환경변수 기반 설정 (`TEST_BASE_URL`, `TEST_STRICT_PARAMS`)

---

## 8. 주요 엣지케이스 및 해결 전략

| 상황 | 문제 | 해결 |
|------|------|------|
| **같은 SQL 반복** | `SELECT * FROM users WHERE id=?` 가 3번 실행 | 순서 기반 큐 소비 (pollExpectedQuery) |
| **동적 SQL** | `<foreach>` 로 파라미터 수에 따라 SQL 변형 | SQL 정규화 시 `IN (?, ?, ?)` → `IN (?)` 로 와일드카드 처리 |
| **Auto-increment ID** | INSERT 후 생성된 ID가 다름 | `useGeneratedKeys` 결과는 실제값 반환, ID 필드는 비교 제외 옵션 |
| **트랜잭션 롤백** | 리플레이 중 실제 DB write 방지 | `@Transactional(readOnly=true)` 강제 or mock 모드에서 `update` intercept 후 row=1 반환 |
| **멀티스레드** | 동시 요청 시 쿼리 로그 혼재 | `ThreadLocal<RecordingSession>` 으로 요청별 완전 격리 |
| **날짜/시간 필드** | `created_at` 같은 동적 필드가 diff 발생 | `--ignore-field created_at` 옵션으로 비교 제외 |
| **페이지네이션** | `LIMIT/OFFSET` 파라미터가 요청마다 다름 | `--ignore-sql-params` 옵션 또는 SQL 파라미터 마스킹 |
| **대용량 ResultSet** | 수천 row의 result 직렬화 | `maxResultSize` 설정으로 저장 row 수 제한 (기본 1,000) |
| **binary/BLOB 컬럼** | 직렬화 불가 | Base64 인코딩 후 저장, 비교 시 제외 처리 |

---

## 9. 설정 (application.yml)

```yaml
api-test:
  enabled: true                  # 전체 기능 활성화
  db-path: ./test-recordings.db  # SQLite 파일 경로
  strict-params: false           # 파라미터까지 SQL 매칭에 사용
  max-result-size: 1000          # ResultSet 저장 최대 row 수
  ignore-fields:                 # 비교 제외 JSON 경로 (정규식)
    - ".*\\.created_at"
    - ".*\\.updated_at"
    - ".*\\.timestamp"
  ignore-sql-params: false       # SQL 파라미터 무시 (SQL 구조만 비교)
  management-path: /api/test     # 관리 API prefix
```

---

## 10. 프로젝트 구조 (신규 모듈 기준)

```
src/main/java/com/example/apitest/
├── config/
│   └── ApiTestConfig.java            # 자동구성, @ConditionalOnProperty
├── core/
│   ├── RecordingSession.java         # 단일 요청의 녹화 세션
│   ├── RecordingContext.java         # ThreadLocal 보관
│   └── QueryLog.java                 # 쿼리 로그 VO
├── filter/
│   └── RecordingFilter.java          # Servlet Filter
├── interceptor/
│   ├── QueryRecordingInterceptor.java # MyBatis Plugin
│   └── SqlNormalizer.java            # SQL 정규화 유틸
├── store/
│   ├── TestCaseStore.java            # SQLite CRUD
│   └── schema.sql                    # DDL
├── compare/
│   ├── JsonDiff.java                 # API 응답 diff
│   └── SqlDiff.java                  # SQL 목록 diff
├── api/
│   ├── TestCaseController.java       # REST API
│   └── dto/                          # 요청/응답 DTO
└── runner/
    ├── ReplayRunner.java             # 프로그래밍 방식 실행
    └── JUnit5Extension.java          # JUnit 5 통합
```

---

## 11. JUnit 5 통합 사용 예시

```java
@SpringBootTest
@ExtendWith(ApiTestExtension.class)
class UserApiTest {

    @ApiTestCase(id = 1, name = "사용자 조회 - 정상")
    @Test
    void testGetUser() {
        // ApiTestExtension이 자동으로 X-Test-Mode: replay 헤더 주입
        // 케이스 ID=1의 mock 쿼리 결과로 실행
        // 테스트 종료 후 자동으로 비교 + JUnit assert
    }

    @ApiTestSuite(ids = {1, 2, 3, 5})
    @Test
    void runSuite() { /* 일괄 실행 */ }
}
```

---

## 12. 개발 우선순위 요약

```
Phase 1 (핵심 녹화)      ████████░░  필수
Phase 2 (리플레이)        ████████░░  필수
Phase 3 (비교 로직)       ██████░░░░  필수
Phase 4 (관리 UI)         ████░░░░░░  권장
Phase 5 (CI/JUnit)        ██░░░░░░░░  선택

전체 예상: 10~13 개발일
```

---

## 13. 현재 Puppeteer 툴과 대응 관계

| Puppeteer 툴 | Spring Boot 툴 |
|---|---|
| `inject.js` (이벤트 캡처) | `QueryRecordingInterceptor` (쿼리 캡처) |
| `RecordingFilter` (HTTP 응답 저장) | `RecordingFilter` (동일 역할) |
| `mockMap` (URL → 응답 매핑) | `session.pollExpectedQuery()` (SQL → 결과 매핑) |
| `canonicalUrl()` (URL 정규화) | `SqlNormalizer.normalize()` (SQL 정규화) |
| `jsonDiff()` (응답 비교) | `JsonDiff.compare()` (동일 로직 Java 이식) |
| `recordings.db` SQLite | `test-recordings.db` SQLite |
| 관리 웹 UI | 관리 웹 UI |
| `run-tests.js` CLI | `java -jar` CLI / JUnit Extension |
