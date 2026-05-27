# 전체 기능 리뷰 + 개선점 도출

> Browser Automation Tool 코드베이스 종합 리뷰. 작성 기준일 2026-04-28.

## 1. 코드베이스 현황

| 영역 | 라인 수 | 비고 |
|---|---:|---|
| `server.js` | 999 | `runReplay` (266줄) + `handleClientMessage` (271줄) 가 여전히 비대 |
| `run-tests.js` | 203 | thin entry — 깔끔 |
| `public/app.js` | **923** | **단일 IIFE, 미리팩터** — 가장 큰 잔여 부채 |
| `public/inject.js` | 245 | 별도 파일이지만 server.js 로직과 중복 가능성 |
| `public/style.css` | 1,022 | 스타일 분리 검토 필요 |
| `src/shared/*` | 801 | url, blocklist, api-filter, db, compare, dispatch, assertions |
| `src/cli/*` | 751 | colors, args, cookies, db, runner, report |
| `src/server/*` | 491 | inject, db, api, export |
| **테스트 코드** | **0** | unit/integration 테스트 없음 — recording replay 로만 검증 |
| 의존성 | 6개 | `cheerio` **미사용** (dead dep) |

---

## 2. 개선점 — 카테고리별 우선순위

### 🔴 CRITICAL — 보안

| # | 이슈 | 영향 | 위치 |
|---|---|---|---|
| **S1** | **WebSocket 인증 / origin 검증 없음** | 네트워크에 노출된 인스턴스는 누구나 연결해 브라우저를 조작 가능. 비로컬 배포 시 즉각적인 공격 표면. | `server.js:41` `new WebSocketServer({ server })` |
| **S2** | **REST API 인증 없음** | `/api/recordings/:id` DELETE 등도 무방비. localhost 가정. | `src/server/api.js` 전체 |
| **S3** | `express.json({ limit: '50mb' })` | DoS 벡터. JSON 50MB 페이로드 허용. | `server.js:43` |
| **S4** | **CSRF 보호 없음** | UI 가 같은 origin 이라 현재는 OK. 다른 origin 에서 띄울 경우 위험. | — |
| **S5** | **rate limiting 없음** | 브라우저 자동화는 자원 소모 큼 — 무제한 요청 차단 필요. | — |

### 🔴 CRITICAL — 아키텍처

| # | 이슈 | 영향 | 처리 방안 |
|---|---|---|---|
| **A1** | `server.js` 의 `handleClientMessage` (271줄) — 17개 case 의 거대 switch | 새 메시지 추가 시 충돌 위험, 테스트 어려움 | `src/server/handlers/` 디렉터리로 case 별 분리, dispatch 테이블 패턴 |
| **A2** | `runReplay` (266줄) — 응답 캡처 + 이벤트 디스패치 + 토스트 + 트리거 + 비교 + 히스토리 저장 + 로깅 | 재사용 어려움, 디버깅 시 길게 스크롤 | per-test 컨텍스트 객체로 추출 (CLI 의 `replayRecording` 수준으로) |
| **A3** | `public/app.js` 단일 IIFE (923줄) | 모든 UI 상태 / 렌더 / 이벤트가 한 파일. **가장 시급** | `<script type="module">` + 파일 분리, 또는 esbuild 도입 |
| **A4** | **전역 mutable state** (`browser`, `activePage`, `isRecording`, `replayCancelled` …) | 멀티 사용자 동시 사용 불가 (현재 single-tenant). 테스트 어려움 | `Session` 클래스로 캡슐화 |

### 🟡 HIGH — 신뢰성

| # | 이슈 | 위치 |
|---|---|---|
| **R1** | silent catch 24개 — 일부 정당 (graceful degradation) 이지만 일부는 디버깅 방해 | grep `catch\s*{}` |
| **R2** | `unhandledRejection` 핸들러 없음 | 미처리 promise reject 가 프로세스를 죽일 수 있음 |
| **R3** | **단위 테스트 0개** — `npm test` 가 recording replay 만 함 | 새 코드 회귀 잡기 어려움. `src/shared/` 모듈은 unit test 만들기 쉬움 |
| **R4** | prepared statements 가 모듈 로드 시점에 생성 (`src/server/db.js:13`) | DB 파일이 없거나 권한 없을 때 즉시 throw. 진단 메시지 부재 |
| **R5** | DB 백업 없음 | `recordings.db` 손상 시 데이터 손실 |

### 🟡 HIGH — 설정 / 하드코딩

| # | 이슈 | 위치 |
|---|---|---|
| **C1** | `VIEWPORT = {1920, 1080}` 하드코드, 두 곳 | `server.js:35`, `src/cli/runner.js:18` |
| **C2** | body size `51200` byte 두 곳 하드코드 | `server.js:180,637`, `src/cli/runner.js:99` |
| **C3** | `TOAST_OBSERVER_SCRIPT` 중복 — 동일 문자열 두 곳 | `src/cli/runner.js:23` ↔ `src/server/inject.js:179` |
| **C4** | `CHROME_PATH` 기본값이 Linux 경로 (`/opt/pw-browsers/...`) | OS 자동 감지 (mac/win/linux) 필요 |
| **C5** | `idleTime` 200/500 하드코드 | `--idle-time` 플래그 |
| **C6** | maxAttempts, network timeout, screencast quality 모두 하드코드 | `src/shared/config.js` 통합 |

### 🟡 HIGH — 데이터 모델

| # | 이슈 | 영향 |
|---|---|---|
| **D1** | events/responses/cookies/toasts 가 JSON 컬럼 (`src/shared/db.js`) | "어떤 녹화가 `/api/orders` 호출하나?" 같은 검색 쿼리 불가. 1000+ 이벤트면 컬럼이 MB 단위 |
| **D2** | schema 버전 컬럼 없음 | 추후 schema 변경 시 마이그레이션 어려움 |
| **D3** | `run_history` 무제한 누적 | 오래된 row 정리 정책 없음 |
| **D4** | export 형식이 도구 독점적 (`src/server/export.js`) | HAR / Cypress / Playwright 호환 export 없어 이식 불가 |

### 🟢 MEDIUM — 개발자 경험

| # | 이슈 |
|---|---|
| **DX1** | README / 아키텍처 문서 없음 — 새 기여자가 `src/` 구조 파악 불가 |
| **DX2** | CHANGELOG 없음 — 큰 기능 추가/명칭 변경 추적 어려움 |
| **DX3** | `--watch` 모드 없음 — recording 변경 시 자동 재실행 |
| **DX4** | `--filter` (실패만 재실행) 없음 |
| **DX5** | `cheerio` 미사용 dependency — `package.json` 정리 필요 |
| **DX6** | structured logging 없음 — `console.log` 만 사용. log level / JSON 형식 옵션 부재 |
| **DX7** | 타입 정의 없음 — Recording / Result 등의 객체 형태가 코드 곳곳에 흩어짐. JSDoc typedef 추가 가능 |

### 🟢 MEDIUM — UI / UX

| # | 이슈 |
|---|---|
| **U1** | 녹화에 어서션 추가 UI 없음 — `assert-text`/`visible`/etc 는 외부 스크립트로만 추가 가능 |
| **U2** | diff 뷰어 없음 — body diff 가 텍스트 한 줄. side-by-side 비교 뷰 필요 |
| **U3** | 키보드 단축키 없음 — Cmd+R 녹화, Cmd+P 재생 등 |
| **U4** | dark mode 토글 없음 |
| **U5** | 다중 사용자 동시 사용 불가 — server-wide single browser instance |
| **U6** | screencast quality 75 JPEG — 한국어 폰트 가독성 낮음. WebP 또는 quality 90 권장 |
| **U7** | 녹화 검색 / 필터 없음 — 페이지 URL 매칭만 있고 태그 / 이름 / 날짜 검색 불가 |

### 🟢 LOW — 기능 한계

| # | 이슈 |
|---|---|
| **F1** | iframe 녹화 미지원 (replay 는 fix 됨) |
| **F2** | Shadow DOM 녹화 미지원 (replay 는 fix 됨) |
| **F3** | file upload / drag-drop 미지원 |
| **F4** | WebSocket 트래픽 캡처 안 됨 — REST API 만 |
| **F5** | `assert-screenshot` 의 PNG diff 가 byte 비교 — 정확한 픽셀 비교 라이브러리 (`pixelmatch`) 도입 가능 |
| **F6** | SSE / EventSource 미지원 |

### 🟢 LOW — 성능

| # | 이슈 |
|---|---|
| **P1** | `pickByLabelOrFirst` 가 candidate 마다 `page.evaluate` — 많은 매치 시 느림 |
| **P2** | DB connection 매번 새로 — connection pool 없음 (low impact, sqlite 가벼움) |
| **P3** | `app.js` 미니파이 / 번들링 없음 — 37KB 한 파일 매번 로드 |

---

## 3. 권장 작업 순서 (impact ÷ effort)

### Tier A — 빠른 수확 (소노력 / 큰 영향)

1. **U1 + DX5 + C3 + 잔여 중복 제거**: 미사용 cheerio 제거, `TOAST_OBSERVER_SCRIPT` / `VIEWPORT` 공유 모듈로
2. **R2**: `process.on('unhandledRejection')` 글로벌 핸들러 추가
3. **C1, C2, C4, C5, C6**: `src/shared/config.js` 신설하고 모든 매직넘버 한 군데로
4. **DX1**: 짧은 README + 아키텍처 다이어그램
5. **DX7**: `src/shared/types.js` JSDoc typedef (Recording, ReplayResult, Event types)

### Tier B — 중간 노력 / 큰 영향

6. **A3**: `public/app.js` 분리 (가장 큰 잔여 부채) — ESM `<script type="module">` 사용
7. **A1**: `handleClientMessage` 의 case 별 핸들러 분리
8. **A2**: `runReplay` 를 `ReplaySession` 클래스로 캡슐화
9. **R3**: 핵심 shared 모듈 (`compare.js`, `blocklist.js`, `url.js`) 단위 테스트 추가
10. **S1, S2, S3**: localhost 외 노출 방지 (loopback bind), 기본 token 인증, body limit 축소

### Tier C — 큰 노력 / 중간 영향

11. **A4**: 전역 state → Session 객체 (멀티 유저 지원의 전제)
12. **D1**: events / responses 별도 정규화 테이블 (검색 / 통계 가능)
13. **F1, F2**: iframe / Shadow DOM 녹화기 측 지원

---

## 4. Tier A 패키지 — 즉시 진행 가능

Tier A 항목 (예상 소요 ~30분~1시간) 은 한 번에 처리해도 회귀 위험이 낮습니다:

- 미사용 `cheerio` dependency 제거
- `VIEWPORT` / `TOAST_OBSERVER_SCRIPT` / body limit / chrome path → `src/shared/config.js` 단일화
- `process.on('unhandledRejection')` + `process.on('uncaughtException')` 글로벌 핸들러
- `src/shared/types.js` JSDoc 타입 정의
- 짧은 `README.md` + 아키텍처 다이어그램 (Mermaid)

---

## 5. 부록 — 진단 명령어 모음

```bash
# 미사용 dependency 검출
grep -rn "require.*cheerio" --include="*.js" .   # cheerio 사용처 — 0건이면 dead

# silent catch 카운트
grep -rn "catch\s*{}\|\.catch(.*=>.*{})" --include="*.js" src/ server.js run-tests.js | wc -l

# 큰 파일 식별
wc -l server.js run-tests.js public/*.{js,html,css} src/**/*.js | sort -rn

# 핸들러 case 카운트
grep -c '^    case "' server.js

# 하드코딩된 매직넘버
grep -rn "51200\|1920\|1080" --include="*.js" .
```

---

*이 리뷰는 정적 분석 + 패턴 매칭 기반이며, 실제 동작은 `npm test` 로 회귀 검증이 됩니다. 현재 모든 회귀 테스트는 통과 상태 (35건 / 35건).*
