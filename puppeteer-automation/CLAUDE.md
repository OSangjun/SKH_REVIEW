# Puppeteer Browser Automation — Project Context

## 목적

사용자의 브라우저 상호작용(클릭, 입력, 키보드, 네비게이션)을 **녹화(Record)**하고 **리플레이(Replay)**하여 회귀 테스트를 자동화하는 도구.

- 실서버 리플레이: 동일한 인터랙션을 재현하고 HTTP 응답을 녹화 시점과 비교
- 목(Mock) 리플레이: 녹화된 응답을 브라우저 요청에 직접 주입 → 실서버 없이 UI 동작 검증
- 두 가지 실행 방식: **서버(GUI) 모드** (`node server.js`) / **CLI 모드** (`node run-tests.js`)

---

## 디렉토리 구조

```
puppeteer-automation/
├── server.js                  # HTTP + WebSocket 서버 진입점 (GUI 모드)
├── run-tests.js               # CLI 테스트 러너 진입점
├── src/
│   ├── index.js               # CLI record/replay 서브커맨드 라우터
│   ├── recorder.js            # CLI 녹화 세션 관리
│   ├── replayer.js            # CLI 리플레이 세션 관리
│   ├── server/
│   │   ├── api.js             # REST API 엔드포인트 (Express)
│   │   ├── browser.js         # Puppeteer 브라우저/페이지 초기화
│   │   ├── comms.js           # WebSocket 메시지 송신 헬퍼 (send/log)
│   │   ├── db.js              # 서버용 DB 접근 함수 (SQLite)
│   │   ├── inject.js          # 페이지에 주입되는 이벤트 캡처 스크립트 (빌더)
│   │   ├── replay.js          # 서버 모드 리플레이 실행 로직 + mapResponsesToEvents
│   │   ├── state.js           # 서버 전역 상태 (page, browser, ws, 녹화 버퍼)
│   │   └── ws-handler.js      # WebSocket 메시지 수신 처리 (navigate/record/replay/suite)
│   ├── cli/
│   │   ├── args.js            # CLI 옵션 파싱 + --help 출력
│   │   ├── colors.js          # 터미널 색상 상수
│   │   ├── cookies.js         # --cookie / --cookie-file 파싱
│   │   ├── db.js              # CLI용 DB 접근 (read-only 조회 위주)
│   │   ├── report.js          # 콘솔 출력 + JSON/JUnit XML 리포트 생성
│   │   └── runner.js          # replayRecording() — CLI 리플레이 핵심 로직
│   └── shared/
│       ├── api-filter.js      # isApiResponse() — XHR/fetch 응답만 캡처 필터
│       ├── assertions.js      # assert-text/visible/attr/count/screenshot + wait-for-* 실행
│       ├── blocklist.js       # 3rd-party 트래커/분석 URL 차단 목록
│       ├── compare.js         # 응답 비교(jsonDiff), 토스트 비교, 트리거 매핑 비교
│       ├── db.js              # SQLite 스키마 초기화 (openDb)
│       ├── dispatch.js        # dispatchEvent(), pickByLabelOrFirst(), waitNetworkIdle()
│       └── url.js             # canonicalUrl(), normalizeUrl(), applyBaseUrl(), pageKey()
├── public/
│   ├── index.html             # 웹 UI (녹화/리플레이 컨트롤 패널)
│   ├── app.js                 # 웹 UI 클라이언트 로직 (WebSocket 통신)
│   ├── inject.js              # 브라우저 iframe 안에 주입되는 프록시 스크립트
│   └── style.css
└── recordings/                # SQLite DB 파일 위치 (gitignore)
```

---

## 핵심 데이터 모델

### SQLite 테이블: `recordings`

| 컬럼 | 타입 | 내용 |
|------|------|------|
| `id` | INTEGER PK | 자동 증가 |
| `name` | TEXT | 사용자 지정 이름 (기본값: `테스트 케이스 #<id>`) |
| `url` | TEXT | 녹화 시작 URL |
| `event_count` | INTEGER | 이벤트 수 |
| `events` | TEXT (JSON) | 이벤트 배열 |
| `responses` | TEXT (JSON) | HTTP 응답 배열 |
| `cookies` | TEXT (JSON) | 세션 쿠키 배열 |
| `toasts` | TEXT (JSON) | 토스트 메시지 배열 |

### 이벤트 객체 (events 배열 원소)

```json
{
  "type": "click|dblclick|input|keydown|keyup|select|check|navigate|scroll|wheel|hover|contenteditable|assert-text|assert-visible|wait-for-selector|...",
  "t": 1234,               // 녹화 시작 기준 상대 타임스탬프(ms)
  "x": 100, "y": 200,     // 좌표 (click/dblclick)
  "selector": "CSS_선택자",
  "label": "텍스트 레이블",
  "value": "입력값",
  "key": "Enter",
  "triggeredUrls": ["https://..."] // 이 이벤트가 유발한 HTTP 요청 URL 목록
}
```

### HTTP 응답 객체 (responses 배열 원소)

```json
{
  "url": "https://api.example.com/data",
  "status": 200,
  "contentType": "application/json",
  "body": "{...}",   // JSON/text/xml만 저장; 바이너리면 null
  "method": "GET",
  "reqBody": null,   // POST/PUT 요청 본문 (GET이면 null)
  "t": 1234
}
```

---

## 실행 흐름

### 녹화 (서버 모드)

1. 브라우저 → `public/inject.js` (iframe 프록시) → WebSocket → `ws-handler.js`
2. `inject.js`가 페이지의 클릭/입력/키보드 이벤트를 캡처해 `__captureEvent()` 호출
3. `src/server/inject.js`의 `buildCaptureScript()`가 페이지에 실제 캡처 코드 주입
4. `ws-handler.js`의 `stop-recording` 핸들러가 `mapResponsesToEvents()`로 이벤트↔HTTP 매핑
5. `dbSaveRecording()`으로 SQLite에 저장

URL 이동 시 자동으로 `name='초기화'` 레코딩 저장 → 목 리플레이의 베이스라인으로 사용

### 리플레이 (서버 모드)

`src/server/replay.js` → `runReplay()`:

1. 브라우저 쿠키/스토리지 초기화
2. 목 모드라면 `page.setRequestInterception(true)` + 요청 핸들러 등록
3. 이벤트 루프: `dispatchReplayEvent()` → `waitNetworkIdle()`
4. post-loop settlement (최대 5회, 연쇄 응답 대기)
5. 응답 비교: `compareResponses()` / `compareToasts()` / `compareTriggerMappings()`
6. `dbSaveHistory()` → `send(replay-result)`

### 리플레이 (CLI 모드)

`src/cli/runner.js` → `replayRecording()`:  
서버 모드와 동일한 로직, 단 WebSocket 없이 콘솔 출력으로 진행

---

## 목(Mock) 리플레이 모드

### 동작 원리

```
녹화된 responses → mockMap (URL → 응답)
                     ↓
브라우저 XHR/fetch 요청 → request.respond(mockMap[canonicalUrl(req.url)])
미매칭 요청 → HTTP 503 반환 (실서버 차단)
```

### URL 키 전략

- `canonicalUrl(url)`: cache-buster 파라미터(`_`, `_t`, `nonce` 등) 제거 후 나머지 유지
- **last-write-wins**: 같은 URL에 여러 응답이 있으면 마지막 것이 우선
- **반복 소비 가능**: 같은 URL 요청이 몇 번 와도 동일 응답 반환 (큐 소비 없음)

### 초기화 레코딩 병합

```
initId = dbFindInitByUrl(startUrl)  // name='초기화'인 레코딩 조회
mockMap ← initId의 responses (베이스라인)
mockMap ← 테스트 레코딩의 responses (덮어쓰기)
```

### CLI 기본값

`run-tests.js`는 `--mock-replay`가 **기본값(true)**. 실서버로 보내려면 `--no-mock-replay` 필요.

---

## 응답 비교 로직 (`src/shared/compare.js`)

| 비교 항목 | 함수 | 결과 |
|-----------|------|------|
| HTTP 응답 (상태코드 + 바디 JSON diff) | `compareResponses()` | `{ url, pass, bodyDiffs[] }` |
| HTTP 상태코드만 2xx 여부 | `buildStatusOnlyResults()` | `{ url, pass }` |
| 토스트 메시지 | `compareToasts()` | `{ text, pass }` |
| 이벤트→HTTP 트리거 매핑 | `compareTriggerMappings()` | `{ eventType, url, pass }` |

JSON diff는 `jsonDiff(expected, actual)` — 재귀적 키 비교, 최대 10개 diff 보고.  
`--ignore-body <regex>`로 동적 필드(타임스탬프, 세션ID 등) 제외 가능.

---

## 선택자 전략 (`src/shared/dispatch.js`)

`pickByLabelOrFirst(page, selector, label)`:
1. 메인 프레임에서 Shadow DOM 포함 `querySelectorAll(selector)`
2. `label`이 있으면 텍스트 일치 + 가시성으로 우선 선택 (El Plus 드롭다운 중복 옵션 대응)
3. 미발견 시 child frame(iframe) 탐색
4. 모두 실패 시 좌표 폴백

**El Plus 특이사항:**
- `el-input`은 `data-testid`를 내부 `<input>`에 포워딩 → 선택자는 `[data-testid="x"]` (래퍼 div 아님)
- `el-select` 옵션은 포털(teleport)로 DOM 밖에 렌더링 → `EL_OPT_RE` 패턴으로 별도 처리
- iframe 내부 좌표는 `getFrameOffset()`으로 보정 (`inject.js`)

---

## 주요 CLI 옵션

```
node run-tests.js [options]

--all                  모든 녹화 실행
--id <n>               특정 ID 실행
--ids <n,n,n>          복수 ID 실행
--fast                 CI 모드 (think-time 제거, domcontentloaded, idleTime 200ms)
--no-mock-replay       실서버로 실제 HTTP 요청 전송 (기본은 목 모드)
--base-url <url>       환경 전환 (staging, QA 등)
--retry <n>            실패 시 재시도 횟수
--parallel <n>         동시 실행 컨텍스트 수
--no-http-compare      HTTP 바디 비교 생략, 2xx 여부만 확인
--junit <file>         JUnit XML 리포트 출력 (CI 연동)
--ignore-host <host>   특정 호스트 응답 비교 제외
--strip-param <name>   URL 매칭 시 제거할 쿼리 파라미터
```

---

## CLI 전용 실행에 필요한 파일

서버(`server.js`, `src/server/`, `public/`) 없이 CLI만 필요한 경우:

```
run-tests.js
src/cli/args.js
src/cli/colors.js
src/cli/cookies.js
src/cli/db.js
src/cli/report.js
src/cli/runner.js
src/shared/api-filter.js
src/shared/assertions.js
src/shared/blocklist.js
src/shared/compare.js
src/shared/db.js          ← SQLite 스키마 초기화
src/shared/dispatch.js
src/shared/url.js
```

---

## 환경 변수 (`.env`)

```
CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
PORT=3000
BASE_URL=                 # 옵션: 리플레이 기본 URL 오버라이드
```

---

## 주요 설계 결정 / 불변 조건

1. **응답 바디 크기 제한 없음**: `response.buffer().then(buf => buf.toString("utf8"))` — SQLite TEXT로 무제한 저장
2. **목 맵 last-write-wins**: 동일 URL 응답이 여러 개면 마지막 것이 사용됨 (순서 비결정적 녹화 대응)
3. **초기화 레코딩**: 페이지 진입 시 자동 저장 (`name='초기화'`). 목 모드의 베이스라인 응답 제공
4. **canonicalUrl**: cache-buster만 제거, 나머지 쿼리파라미터 유지 → 의미있는 파라미터 차이는 다른 응답으로 구분
5. **triggerMapping**: 이벤트 타임스탬프 기반으로 이벤트↔HTTP 응답 연결 (녹화 시); 리플레이 시 URL로 재검증
6. **post-loop settlement**: 리플레이 이벤트 루프 완료 후 최대 5회 네트워크 유휴 대기 → A→B→C 연쇄 요청 대응
