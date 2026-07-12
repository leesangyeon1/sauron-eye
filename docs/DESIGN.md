# Sauron Eye — 설계 문서

> 2026-07-12 승인. 모든 Claude Code(및 이후 Codex/Gemini/Grok) 세션을 한 눈에:
> **상태 · 모델 · 토큰/쿼터 · 로드된 프리셋 · 에이전트 트리** — 웹(시각화)과 TUI(실사용) 두 화면.

## 0. 왜 만드나 (문제 정의)

사용자 통증 4개 — 전부 "세션 행 하나"의 컬럼임:

```
세션 행 = [상태] [모델] [토큰/쿼터] [프리셋: 스킬·MCP] [worktree]
           ↑p1    ↑p2     ↑p2          ↑p3               ↑p4
p1: 세션이 지금 뭐 하는지 모름 (working / idle / 입력대기)
p2: 토큰·5h/7d 한도 언제 터질지 모름
p3: 어떤 스킬/플러그인/MCP/CLAUDE.md 로 도는지 모름
p4: 에이전트 여러 개 굴리기(worktree·터미널 분할) 귀찮음
```

시장 조사 결론(2026-07): 이 조합(프리셋 관리 + 라이브 크로스 프로바이더 관측)을
하나로 하는 도구 없음. 단, 카테고리 사망률 극심 — 사인은 전부 동일:
**문서화 안 된 내부 파일 파싱** (Headrm 사망, Omnara 아카이브 사유 원문:
"wrapping Claude Code CLI became unfeasible to maintain").

## 1. 생존 원칙 (설계를 지배하는 단 하나의 규칙)

> **라이브 데이터는 문서화된 푸시 표면에서만 받는다.
> 내부 파일을 아는 코드는 `adapters/` 한 곳에 가둔다.**

| 데이터 | 출처 | 문서화 | 깨질 위험 |
|---|---|---|---|
| 모델·비용·컨텍스트%·5h/7d 쿼터 | statusline stdin JSON | ✅ 공식 | 없음 (Anthropic이 밀어줌) |
| working/idle/입력대기 상태 전이 | hooks (SessionStart/End/Stop/Notification/UserPromptSubmit) | ✅ 공식 | 없음 |
| 스킬·플러그인·MCP·서브에이전트·툴 이벤트 | OTel (CLAUDE_CODE_ENABLE_TELEMETRY) | ✅ 공식 | 없음 |
| 과거 세션 히스토리, 세션 이름 | ~/.claude/ 내부 파일 | ❌ 비공식 | **높음 → adapters/claude.js 격리** |

`adapters/claude.js` 가 깨져도(포맷 변경) 라이브 기능은 전부 동작한다.
어댑터는 try/catch 전면 방어 + 실패 시 빈 결과 반환. 절대 프로세스를 못 죽인다.

## 2. 아키텍처

```
 Claude Code 세션들 (N개)
      │ (푸시)
 ┌────┴─────────────────────────────────────────────┐
 │ collectors/  ← Claude 가 실행해주는 초경량 스크립트  │
 │  statusline.js  매 턴: 모델·비용·쿼터 → POST /ingest │
 │  hook.js        수명주기 이벤트 → POST /ingest       │
 │  (OTel receiver: Phase 2)                          │
 └────┬─────────────────────────────────────────────┘
      │ HTTP (localhost only)
 ┌────▼─────────────────────────┐
 │ core/  sauron 데몬 (:4870)    │ ← 진실의 원천
 │  registry  세션 상태머신       │
 │  store     SQLite(node:sqlite)│
 │  api       HTTP + SSE         │
 └───┬──────────────────┬───────┘
     │ 같은 API          │ 같은 API
 ┌───▼────────┐   ┌─────▼───────┐
 │ web/  보는곳 │   │ tui/  하는곳 │
 │ 카드·게이지· │   │ 테이블·스폰· │
 │ DAG 시각화   │   │ tmux 연동    │
 └────────────┘   └─────────────┘
      ▲ (히스토리 백필만)
 adapters/claude.js — 내부 포맷 아는 유일한 파일
```

**core 가 진실, web/tui 는 껍데기.** 클라이언트는 `/api/*` + SSE만 안다.

## 3. 세션 상태머신

```
(statusline beat 또는 SessionStart) ──→ working
UserPromptSubmit ──→ working
Stop(턴 종료)     ──→ idle          (내 입력 기다림)
Notification      ──→ needs_input   (권한/질문 대기)
SessionEnd        ──→ ended
beat 5분 없음     ──→ stale         (죽었거나 방치)
```

statusline 은 매 렌더마다 오므로 **하트비트 겸용**. 별도 폴링 없음.

## 4. 모듈 경계 (제품화 대비)

```
sauron-eye/
├─ bin/sauron.js        # CLI 진입점: start|tui|install|status
├─ core/                # 어댑터 무관. 추상 Session 만 앎
│  ├─ server.js         # HTTP + SSE + 라우팅
│  ├─ registry.js       # 상태머신 + 인메모리 세션 맵
│  └─ store.js          # node:sqlite (Node 22+ 내장, 의존성 0)
├─ collectors/
│  ├─ statusline.js     # stdin JSON → POST, 기존 statusline 체이닝(출력 보존)
│  ├─ hook.js           # 훅 이벤트 → POST (50ms 타임아웃, 실패 무시)
│  └─ install.js        # ~/.claude/settings.json 에 훅/statusline 병합(머지, 덮어쓰기 금지)
├─ adapters/
│  └─ claude.js         # ⚠️ 내부 포맷 아는 유일한 파일 (히스토리 백필)
├─ web/public/          # 정적 1페이지 (vanilla JS + SSE)
├─ tui/tui.js           # ANSI TUI (tmux 스폰 연동)
└─ test/                # node:test
```

의존성 **0** (AI Refrigerator 와 같은 규칙). Node ≥ 22.5 (`node:sqlite`).

## 5. 웹 vs TUI 역할

| | web (보는 곳) | tui (하는 곳) |
|---|---|---|
| 세션 | 카드 그리드, 상태 색 | 테이블 + 키보드 |
| 쿼터 | 5h/7d 게이지 + 추이 | 상단 바 한 줄 |
| 에이전트 | DAG 트리(Phase 2, OTel) | 텍스트 트리(Phase 2) |
| 스폰 | 버튼(Phase 2) | `s` 키 → tmux split + `claude -w` |
| 프리셋 | AI Refrigerator 연동(Phase 3) | `:apply`(Phase 3) |

멀티플렉싱은 **tmux 에 위임** (재발명 금지). tmux 없으면 스폰 커맨드를 출력만.

## 6. 파이프라인

```
poc ──PR──→ dev ──PR──→ qa ──PR──→ prod
 실험         보강+CI      E2E 검수    태그 릴리스
```

- 모든 push/PR: `node --test` (ci.yml)
- prod push: GitHub Release 자동 생성 (release.yml)
- 개인 도구 단계의 "배포" = GitHub Release tarball + `npx` 실행

## 7. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| Anthropic 내부 포맷 변경 | adapters/ 격리 — 그 파일만 고침, 라이브 무중단 |
| Anthropic 이 기능 자체를 흡수 (claude agents 등) | 차별점은 크로스 프로바이더 + 프리셋 결합. 어댑터 추가로 대응 |
| settings.json 머지 실패로 사용자 설정 파손 | install 은 항상 백업 생성 + 머지 전 diff 출력 + dry-run 기본 |
| 훅/statusline 이 Claude 를 느리게 함 | collector 는 fire-and-forget, 총 예산 50ms, 실패 무시 |

## 8. 성공 기준 (POC)

1. `sauron start` → 데몬 부팅, `sauron install` → 훅 설치(백업 포함)
2. Claude Code 세션 2개 열면 웹/TUI 에 행 2개, 상태·모델·쿼터 실시간 갱신
3. 세션에서 입력 대기 시작 → 5초 내 `idle` 로 전환 표시
4. `node --test` 그린
