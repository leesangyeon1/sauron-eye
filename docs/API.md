# Sauron Eye — API 계약 (core ↔ collectors ↔ clients)

포트 `4870`, 바인딩 `127.0.0.1` 전용. 모든 바디 JSON.
이 문서가 계약이다 — core/web/tui/collectors 는 이 문서만 보고 병렬 개발한다.

## Ingest (collectors → core)

### POST /ingest/statusline
statusline collector 가 매 렌더마다 전송. 하트비트 겸용.

```json
{
  "sessionId": "3fac24f8-...",          // stdin JSON 의 session_id
  "ts": 1783900000000,
  "model": { "id": "claude-sonnet-5", "display_name": "Sonnet 5" },
  "cost": { "total_cost_usd": 1.23, "total_duration_ms": 456789 },
  "context": { "used_pct": 42, "size": 200000, "input_tokens": 1, "output_tokens": 2 },
  "rate": {
    "five_hour": { "used_pct": 61, "resets_at": "2026-07-12T09:00:00Z" },
    "seven_day": { "used_pct": 38, "resets_at": "2026-07-15T00:00:00Z" }
  },
  "cwd": "/Users/x/proj",
  "project_dir": "/Users/x/proj",
  "git_branch": "dev"                    // 있으면
}
```
누락 필드 허용(관대한 파서). 응답 `{"ok":true}` 204도 가능.

### POST /ingest/hook
```json
{ "sessionId": "...", "ts": 1783900000000,
  "event": "session_start|session_end|stop|notification|user_prompt_submit",
  "cwd": "/Users/x/proj", "meta": {} }
```

## 상태머신 (core registry 구현 규칙)

```
session_start | user_prompt_submit | statusline beat(신규) → working
stop         → idle
notification → needs_input
session_end  → ended
마지막 beat 5분 초과 (ended 아님) → stale
```
우선순위: 명시적 훅 이벤트 > beat 추론. beat 는 ended 세션을 되살리지 않는다.

## Query (clients → core)

### GET /api/sessions
```json
{ "sessions": [ {
    "sessionId": "...", "state": "working|idle|needs_input|stale|ended",
    "model": "Sonnet 5", "modelId": "claude-sonnet-5",
    "costUsd": 1.23, "contextPct": 42,
    "rate5h": { "usedPct": 61, "resetsAt": "..." },
    "rate7d": { "usedPct": 38, "resetsAt": "..." },
    "cwd": "...", "gitBranch": "...", "name": "...",   // name 은 adapter 백필(없으면 null)
    "firstSeen": 0, "lastSeen": 0, "source": "live|history"
} ] }
```
정렬: live 먼저, lastSeen 내림차순. `?include=history` 시 어댑터 백필 포함.

### GET /api/quota
가장 최근 beat 기준 프로바이더별 쿼터 스냅샷.
```json
{ "providers": { "claude": { "rate5h": {...}, "rate7d": {...}, "asOf": 0 } } }
```

### GET /api/events  (SSE)
```
event: session   data: {세션 객체}        // 상태/필드 변경마다
event: quota     data: {providers 객체}   // 쿼터 변경마다
```
연결 직후 현재 전체 스냅샷을 session 이벤트로 재생 후 스트림.

### GET /api/health
`{ "ok": true, "version": "0.1.0", "sessions": 3 }`

### GET /
web/public/index.html 정적 서빙 (path traversal 방어 필수).

## Adapter 인터페이스 (core → adapters)

```js
// adapters/claude.js — 반드시 이 시그니처. 실패 시 throw 금지, 빈 값 반환.
export async function backfillSessions()  // → [{sessionId, name, cwd, lastSeen, source:'history'}]
export async function sessionName(sessionId) // → string | null
```

## Collector 규칙

- POST 타임아웃 50ms, 실패 무시 (Claude 를 절대 느리게 하지 않는다)
- statusline.js: stdin 전체 읽음 → 변환 POST → **기존 statusline 명령을 exec 하고
  그 stdout 을 그대로 출력** (사용자 화면 불변). 기존 명령은 `~/.sauron/config.json` 의
  `chainStatusline` 에 저장.
- hook.js: argv[2] 로 이벤트명 받음. stdin(훅 JSON)에서 session_id, cwd 추출.

## 파일 위치

- DB: `~/.sauron/sauron.db` (node:sqlite)
- 설정: `~/.sauron/config.json` `{ port, chainStatusline }`
- 설치 백업: `~/.sauron/backups/settings.json.<ts>`

---

# v2 확장 (Phase 2 — provider groups · activity · map)

## Session 확장 필드
```json
{ "provider": "claude|codex|gemini|cursor|antigravity|unknown",
  "activity": {
    "openTools":  [{ "name": "Bash", "server": null, "startedAt": 0 }],
    "recentTools":[{ "name": "mcp__github__search", "server": "github", "ms": 812, "endedAt": 0 }],
    "skills":     [{ "name": "deep-research", "count": 2, "lastUsed": 0 }],
    "agents":     [{ "type": "Explore", "startedAt": 0, "endedAt": null }],
    "mcpServers": ["github", "obsidian"]
  } }
```
recentTools 최근 20개 캡, openTools 는 post/stop 이벤트로 닫힘. 전부 있을 때만 채움(관대).

## POST /ingest/hook 이벤트 추가
`pre_tool_use | post_tool_use | subagent_stop`
meta: `{ "tool_name": "...", "tool_use_id": "...", "tool_input": {…512B 캡} }`
registry 해석 규칙:
- tool_name `Skill` → skills 집계 (tool_input.skill ?? .name ?? .command)
- tool_name `mcp__<server>__<tool>` → mcpServers + 툴 기록(server 분리)
- tool_name `Task` → agents 시작 (tool_input.subagent_type), subagent_stop 으로 닫음
- post_tool_use 는 tool_use_id 우선, 없으면 같은 이름 LIFO 로 닫고 ms 계산

## GET /api/groups
```json
{ "groups": [ {
    "provider": "claude", "label": "Claude Code", "installed": true,
    "usage": { "rate5h": {...}, "rate7d": {...}, "costUsd": 12.3 },
    "plan": null,
    "sessions": [ /* 확장 Session 카드 */ ]
} ] }
```
세션 0개여도 어댑터 detect() 가 설치 확인한 프로바이더는 포함. 정렬: 세션 많은 순.

## Provider 어댑터 인터페이스 (전부 격리, throw 금지)
```js
// adapters/<provider>.js
export async function detect()           // → { installed, version?, plan? } | { installed:false }
export async function backfillSessions() // → [{sessionId, provider, name?, cwd?, lastSeen, source:'history'}]
```

## Map (오케스트레이션 블루프린트 — 편집기+내보내기. 실행은 Phase 4)
- `GET /api/map` → `{ "nodes": [{id,type:"provider|mcp|note",x,y,label,meta}], "edges": [{id,from,to,kind:"mcp|flow",label?}] }`
- `PUT /api/map` 전체 문서 저장 (SQLite kv)
- `GET /api/mcp/catalog` → 알려진 MCP 서버 목록 + 설정 템플릿 (github, obsidian, filesystem, …)
- `GET /api/map/export` → 맵의 mcp 노드들로 `.mcp.json` 스니펫 생성

## bin 추가
`sauron app` — 데몬 헬스 확인(다운이면 detached 스폰) 후 Chromium 계열 `--app=http://127.0.0.1:4870` 창. 없으면 기본 브라우저.
