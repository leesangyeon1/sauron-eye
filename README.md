# 👁️ Sauron Eye

**One eye over all your AI coding sessions.**

로컬에서 도는 모든 Claude Code(이후 Codex/Gemini/Grok) 세션을 한 화면에:
**상태(working/idle/입력대기) · 모델 · 비용 · 컨텍스트 · 5h/7d 쿼터** — 실시간.

- 🌐 **Web** (`localhost:4870`) — 보는 곳: 세션 카드, 쿼터 게이지, (Phase 2) 에이전트 DAG
- ⌨️ **TUI** (`sauron tui`) — 하는 곳: 테이블 뷰, tmux 로 세션 스폰
- 🧩 **의존성 0** — Node 22+ 내장 모듈만 (`node:sqlite` 포함)
- 🔒 **로컬 전용** — 127.0.0.1 바인딩, 데이터는 `~/.sauron/` 밖으로 안 나감
- 🛡️ **생존 설계** — 라이브 데이터는 전부 [문서화된 표면](docs/DESIGN.md#1-생존-원칙)(statusline/hooks/OTel)에서.
  내부 파일 파싱은 `adapters/` 한 파일에 격리 → Anthropic 업데이트에 안 죽음

## Quickstart

```bash
git clone https://github.com/leesangyeon1/sauron-eye && cd sauron-eye
node bin/sauron.js install   # ~/.claude/settings.json 에 훅 병합 (백업 자동 생성)
node bin/sauron.js start     # 데몬 :4870
node bin/sauron.js tui       # 터미널 대시보드 (웹은 http://127.0.0.1:4870)
```

새 Claude Code 세션을 열면 자동으로 나타난다. 기존 statusline 표시는 그대로 유지된다(체이닝).

## 어떻게 동작하나

```
Claude Code ──statusline JSON──→ collector ──POST──→ sauron 데몬 ──SSE──→ web / tui
            ──hooks(수명주기)──→ collector ──POST──→   (SQLite)
```

statusline 이 매 턴 밀어주는 공식 JSON(모델·비용·컨텍스트·rate_limits)이 하트비트,
hooks(Stop/Notification/SessionStart…)가 상태 전이. 폴링 없음, 파일 감시 없음.

## 파이프라인

```
poc ──PR──→ dev ──PR──→ qa ──PR──→ prod (push 시 자동 Release)
실험         보강+CI      E2E 검수    배포
```

## 문서

- [설계](docs/DESIGN.md) · [API 계약](docs/API.md) · [개발 계획](docs/PLAN.md)

## License

MIT
