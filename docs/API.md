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

---

# Phase 2 확장 (worktree 격리 + spawn — ultimate-system/docs/WORKTREE.md 가 설계 원본)

## POST /api/worktree/create
```json
{ "repoPath": "/abs/path", "branch": "feat/x", "baseBranch": "main",
  "presetId": "backend-api", "launch": true, "paneTarget": "%5" }
```
repoPath 만 필수. branch 기본값 `sauron/<repo-slug>-<yyyymmdd-HHmmss>`.
같은 branch 재호출 = 기존 worktree 반환(`reused:true`), 새로 안 만듦.
```json
{ "ok": true, "reused": false, "id": "uuid", "worktreePath": "...", "branch": "...",
  "baseBranch": "main", "command": "cd '...' && claude",
  "surface": { "ok": true, "note": "tmux session ...", "hint": "tmux attach -t ..." },
  "warnings": ["preset \"x\" skipped — AI-Refrigerator not running ..."] }
```
- 프리셋: AI-Refrigerator `POST :4924/api/apply` (mode=project). 소프트 디펜던시 —
  다운이면 warnings 로만.
- surface: `surfaces/tmux.js` (계약: throw 금지, 실패 시 `{ok:false,hint}`).
  paneTarget 있으면 그 pane split, 없으면 detached 세션 + attach 힌트.
  실패해도 create 는 성공 — `command` 로 수동 실행.

## GET /api/worktree/list
```json
{ "worktrees": [ { "id": "...", "repoPath": "...", "branch": "...", "worktreePath": "...",
  "status": "provisioning|active|pending-cleanup|clean|dirty",
  "sessionId": "...", "presetId": "...", "createdAt": 0, "endedAt": null,
  "session": { "state": "working", "model": "Sonnet 5", "costUsd": 1.2 } } ] }
```
removed 는 제외. session 은 registry 라이브 조인(없으면 null).

## POST /api/worktree/gc
`{ "dryRun": true }` (기본 true — false 를 명시해야 실삭제)
```json
{ "clean": [...], "dirty": [{..., "uncommitted": true, "unmerged": false}],
  "removed": [...], "missing": [...], "errors": [{"id","branch","error"}] }
```
규칙: dirty(미커밋 또는 미머지)는 **절대 삭제 안 함**, 매 실행마다 재검사만.
clean 삭제는 `git worktree remove`(--force 금지) + `git branch -d`(-D 금지).
- 고아 active(링크된 세션이 stale/ended/실종 — session_end 못 받은 죽음): pending-cleanup 으로
  강등 후 정상 처리. 살아있는 세션의 active 는 절대 안 건드림 (await 후 재확인, TOCTOU 방지).
- missing(디렉토리 사라짐): tombstone + `git worktree prune` — 브랜치 점유 해제, 재spawn 가능.
- merged 판정은 `merge-base --is-ancestor refs/heads/<branch> <base>` — exit 1 만 "미머지",
  그 외(base 삭제 등)는 errors 로 분리 (dirty 오분류 금지).

## DELETE /api/worktree/:ref
ref = id 또는 worktree 경로. body `{ "force": false }`.
active(세션 살아있음) → 400. dirty + force=false → 400.
force=true 는 사람이 명시한 유일한 --force 경로 — 브랜치는 항상 남김.

## SSE 추가
`event: worktree  data: {worktree 객체}` — 상태 전이마다. 연결 직후 스냅샷 재생.

## 세션 연결 (registry 무변경)
worktree.js 가 registry.subscribe 로 올라탐: cwd(realpath) == worktreePath 인 세션 이벤트 →
`active` + sessionId 링크. `ended` → `pending-cleanup`. 재시작 시 디렉토리 사라진 행은
removed 톰스톤 (git 이 진실, DB 는 캐시).

## bin 추가 (Phase 2)
```
sauron spawn <repo> [--branch B] [--base B] [--preset P] [--via tmux] [--no-launch]
sauron worktree ls | gc [--force] | rm <id|path> [--force]
```
spawn 은 $TMUX_PANE 을 paneTarget 으로 전달 — tmux 안에서 실행하면 제자리 split.

## GET /api/presets (Phase 3)
AI-Refrigerator `GET :4924/api/presets` 프록시 (브라우저 CORS 우회용).
`{ "ok": true, "presets": [{ "id", "name", "emoji" }] }` — fridge 다운이면 빈 배열 (soft).

## UI (Phase 3)
- web `#worktrees` 탭: spawn 폼(repo/branch/base/preset datalist) · GC dry-run→force 2단계 ·
  행별 ⧉cd(커맨드 복사)/🗑(rm, dirty 면 force 재확인) · SSE worktree 이벤트로 라이브 갱신,
  세션 상태는 클라이언트 조인(sessions Map).
- tui: `w` 세션⇄worktree 뷰 토글, `s` spawn(footer 프롬프트: repo→preset, $TMUX_PANE 스플릿),
  worktree 뷰에서 `g` gc dry / `G` gc force(y/N) / `x` rm(dirty 면 force 재확인).
- create 의 repoPath 는 `~/` 프리픽스 허용 (서버가 homedir 확장).
