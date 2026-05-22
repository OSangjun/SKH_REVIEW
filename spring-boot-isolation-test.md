# Java Spring Boot 격리 테스트 도구 — 요건 및 기술 스택

---

## 요건

### 트리거 (테스트 실행 진입점)

| 트리거 | 방법 |
|---|---|
| HTTP 요청 | `POST /api/xxx` 직접 전송 |
| Spring Scheduler | `POST /actuator/test-trigger/{beanName}` (`@Profile("test")` 전용 endpoint) |
| Quartz Trigger | `POST /actuator/quartz/trigger/{key}` |

### 녹화 대상

| 대상 | 캡처 방법 |
|---|---|
| 외부 서비스 HTTP 호출 | `ClientHttpRequestInterceptor` (RestTemplate / WebClient / Feign) |
| DB SELECT | P6Spy `onAfterResultSetNext` → resultRows 행별 누적 |
| DB INSERT / UPDATE / DELETE | P6Spy `onAfterExecuteUpdate` → affectedRows 캡처 |

### 재생 격리 (외부 의존성 완전 차단)

| 격리 대상 | 방법 |
|---|---|
| 외부 HTTP 서비스 | WireMock 스텁 — 녹화된 request/response 자동 로딩 |
| DB SELECT | datasource-proxy 스텁 — 녹화된 ResultSet 반환 |
| DB DML | datasource-proxy 스텁 — 실행 차단 + 녹화된 affectedRows 반환 |

### 성공/실패 판정 기준

재생 후 아래 두 가지를 **모두** 통과해야 PASS.

**① HTTP 응답 비교**
- 상태코드 일치
- JSON body deep diff

**② DB 처리 쿼리 비교 (INSERT / UPDATE / DELETE)**
- 녹화된 DML이 재생에서도 동일 순서로 실행되었는가
- `normalizedSql` 완전 일치
- `params[]` 배열 순서·값 일치
- `affectedRows` 일치

> SELECT는 mock 반환이므로 비교 불필요. DML은 실 DB에 쓰지 않으므로 side effect 없음.

### CI 실행

```
node run-java-tests.js --all
  또는
mvn test  (JUnit Extension 방식)
```

JUnit XML 리포트 생성 → CI `test` 단계에서 자동 pass/fail 판정.

---

## 기술 스택

### Node.js (기존 서버 확장)

| 패키지 | 용도 |
|---|---|
| `axios` | Spring Boot 트리거 endpoint 호출 |
| `better-sqlite3` | 녹화 데이터 저장 (기존 재사용) |
| `ws` | Java 인터셉터 → Node.js 실시간 데이터 수신 (기존 재사용) |

### Java / Spring Boot

| 기술 | 용도 |
|---|---|
| `p6spy` | JDBC 프록시 드라이버 — SQL·파라미터·ResultSet·affectedRows 캡처 |
| `datasource-proxy` | 재생 시 SELECT mock 반환, DML 실행 차단 및 affectedRows 반환 |
| `WireMock` | 재생 시 외부 HTTP 서비스 mock |
| `Spring Actuator` | Scheduler·Quartz 트리거 endpoint 노출 (`@Profile("test")` 전용) |
| `spring-boot-test` | `@SpringBootTest`, `@AutoConfigureWireMock` 테스트 컨텍스트 |

### 공통

| 항목 | 용도 |
|---|---|
| SQLite | 녹화 데이터 저장 — trigger, http_calls, sql_calls |
| JUnit XML | CI `test` 단계 pass/fail 리포트 |

---

## sql_calls 데이터 구조

```json
{
  "sql": "INSERT INTO orders (user_id, amount) VALUES (?, ?)",
  "normalizedSql": "insert into orders(user_id,amount)values(?,?)",
  "params": [42, 9900],
  "queryType": "INSERT",
  "resultRows": null,
  "affectedRows": 1,
  "executionMs": 3,
  "t": 1716000001234
}
```

- `queryType`: `SELECT` | `INSERT` | `UPDATE` | `DELETE`
- `resultRows`: SELECT 전용 (`[{col: val}]`), DML이면 `null`
- `affectedRows`: DML 전용 (영향받은 행 수), SELECT이면 `null`
