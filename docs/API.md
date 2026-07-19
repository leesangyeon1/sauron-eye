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

## Phase 5 — swarm (병렬 시도 → 비교 → 채택)

### POST /api/swarm/create
`{ repoPath, count(2..10), prompt(필수), branch?, baseBranch?, presetId?, via?, paneTarget?, launch? }`
브랜치 `<base>-a … -<n>`, 전원 동일 prompt (`claude '<prompt>'` 로 실행), 하나의 swarmId.
응답: `{ ok, swarmId, prompt, members: [create 응답…], quota }` — quota 는 spawn 시점 스냅샷
(N 병렬 세션 쿼터 경고용). 부분 실패 시 ok:false + 성공한 members 는 그대로 살아있음.

### GET /api/swarm/list
`{ swarms: [{ swarmId, prompt, repoPath, baseBranch, createdAt, members:[pub+session] }] }`

### GET /api/worktree/diff?ref=<id|path>
`{ ok, branch, baseBranch, stat, untracked:[…], diff, truncated }` —
working tree vs base (커밋+스테이징+미커밋 전부), 400KB 캡.

### POST /api/swarm/adopt  `{ winnerId }`
1. winner 미커밋 있으면 거부 (세션에서 커밋 먼저)
2. 저장소 본 체크아웃이 baseBranch 위 + clean 일 때만 `merge --no-ff` (아니면 수동 머지 안내)
3. 충돌 → `merge --abort` 후 에러 (저장소 무손상)
4. 패자: worktree 만 force 제거(명시적 폐기 결정), **브랜치는 유지** — 응답 branchCleanup 에
   수동 삭제 커맨드. 라이브 세션 있는 패자는 skip (losersSkipped).
5. winner 는 pending-cleanup 전이 (라이브 세션 있으면 유지) → 이후 일반 gc 가 수거.

### CLI
```
sauron spawn <repo> --swarm 3 --prompt "태스크"   # 멤버 목록 + 쿼터 70%+ 경고
sauron swarm ls
sauron swarm adopt <winner-worktree-id>
```

### web
Worktrees 탭 상단에 swarm 카드 — 멤버별 상태/세션/[diff]/[👑 채택].
diff 모달: +/-/hunk 컬러, stat + untracked + truncated 표시.

## Phase 8 — 멀티 에이전트 (codex/gemini/grok)

### spawn --agent
`sauron spawn <repo> --agent claude|codex|gemini|grok [--prompt …]` (기본 claude).
swarm 도 `--agent` 지원 — 멤버 전원 같은 에이전트. 실행 커맨드(문법 전부 각 CLI --help 검증):
| agent | prompt 있음 | 없음 |
|---|---|---|
| claude | `claude '<p>'` | `claude` |
| codex | `codex '<p>'` | `codex` |
| gemini | `gemini -i '<p>'` | `gemini` |
| grok | `grok '<p>'` | `grok` |
worktree 행에 agent 저장·표시(claude 외엔 배지). API create/swarm body 에 `agent` 필드.

### sauron install --agents (관측 호환)
각 CLI 의 훅/notify 를 collectors/hook.js 로 배선 — 다른 provider 로 라이브 표시:
- **gemini**: `~/.gemini/settings.json` hooks 병합 (SessionStart/End/Notification/BeforeTool/
  AfterTool → 우리 이벤트). Claude 와 동일 머지 방식, 사용자 키 보존.
- **grok**: `~/.grok/hooks/sauron.json` (Claude 호환 이벤트 8종, stdin JSON).
- **codex**: `~/.codex/config.toml` 의 `notify` (없을 때만 추가, 기존 것 절대 안 건드림).
  turn-complete 만 있어 codex 세션은 working↔idle 만 — session end 없음.
- 각 CLI 설정 디렉토리 없으면 skip. hook.js 는 provider 인자(argv[3]) 로 라벨 구분,
  세션 payload 필드명 차이(session_id/thread-id/cwd/workingDirectory) 관대 파싱.
- 한계: spawn 은 4개 다 완전 지원, **라이브 관측은 claude 가 완전**(전 이벤트), grok/gemini
  는 훅으로 대부분, codex 는 turn-complete 만.

## Phase 6 — cron 자동화 + map 실행 연결

### sauron cron (데몬 API 아님 — 사용자 crontab 관리)
```
sauron cron add "0 3 * * *" -- spawn ~/projects/x --preset token-saver --prompt "deps 업데이트"
sauron cron ls
sauron cron rm <id>
```
- 우리 라인만 `# sauron:<id>` 태그로 관리 — 사용자의 기존 crontab 라인은 바이트 동일 보존.
- 스케줄 검증(5필드 또는 @daily 류), 인자 전부 sh 단일인용 + `%` 이스케이프(crontab 개행 규칙).
- 등록되는 커맨드는 `spawn` 만 허용, `--ensure-daemon` 자동 부착 — 새벽에 데몬 없으면
  spawn 이 detached 로 띄우고 5s 헬스 대기 후 진행. 로그: `~/.sauron/cron.log`.

### map → spawn (web)
Map 탭에서 provider 노드 선택 시 `🌱 spawn` 버튼 — 노드 `meta.repo` (첫 실행 때 물어보고
맵 문서에 저장) 로 `/api/worktree/create` 호출. 오케스트레이션 블루프린트에서 바로 실행.

### superset — 통합 제외 결정 (조사 결과)
`superset workspaces create --project prj_… --branch … --local` — superset 은 자체 프로젝트
등록 + **자체 worktree** 를 만들며, "지정 cwd 에서 커맨드 실행" CLI 가 없다 (tmux/cmux 와 달리
표면이 아님). 어댑터로 잇으면 이중 worktree. 우리 격리 레이어와 **대체재 관계** — 통합 대신
필요 기능(swarm diff/adopt=Phase 5, automations=Phase 6 cron)을 자체 구현으로 흡수 완료.

## Phase 4 — surfaces/cmux + 알림
- `surfaces/cmux.js`: `cmux --json new-workspace --cwd <p> --command <c> [--description <t>]`
  (문법 출처: manaflow-ai/cmux docs/cli-contract.md). detect() 는 binary(`--version`)와
  app 구동(`ping`) 을 구분. ENOENT/소켓 거부 → 설치/실행 힌트.
- `surfaces/auto.js`: 라우터 — `--via` 명시가 우선, 미지정 시 cmux(app running) > tmux > 없음.
  create body/CLI `--via` 는 `tmux|cmux`.
- `core/notifier.js`: 세션이 needs_input 으로 **전이하는 순간** macOS 알림(osascript).
  재진입 전까지 중복 발화 없음. darwin 전용, `SAURON_NOTIFY=0` 으로 끔. 표면 무관 동작.
