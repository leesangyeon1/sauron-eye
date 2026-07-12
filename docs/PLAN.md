# Sauron Eye — 개발 계획

## 로드맵

### Phase 1 — POC (지금, poc 브랜치)
목표: 내 4가지 통증 중 1·2 를 오늘 해결. "세션들이 뭐 하는지 + 쿼터" 라이브.

- [x] 설계/API 계약/파이프라인 문서
- [ ] core: 데몬(HTTP+SSE), registry 상태머신, SQLite 저장
- [ ] collectors: statusline 체이닝 수집기, hook 수집기, 안전 설치기(백업+머지)
- [ ] adapters/claude.js: 세션 이름·히스토리 백필 (격리, 실패 무해)
- [ ] web: 1페이지 대시보드 (카드, 쿼터 게이지, SSE 라이브)
- [ ] tui: 테이블 뷰 + tmux 스폰
- [ ] test: 상태머신 + ingest + 설치 머지 로직
- [ ] 실전 검증: 실제 세션 2개로 성공 기준 4항목 통과

### Phase 2 — dev 브랜치 (보강)
- OTel receiver → 스킬/플러그인/MCP/서브에이전트 가시화 (통증 3)
- 웹 에이전트 DAG 트리 (OTel 스팬)
- Codex 어댑터 (~/.codex + config.toml OTel)
- 세션 스폰 UX (worktree 이름/프리셋 선택)

### Phase 3 — qa/prod (제품화 실험)
- AI Refrigerator 프리셋 연동 (적용된 프리셋을 세션 행에 표시)
- Gemini/Grok 어댑터
- 패키징: npx sauron-eye, GitHub Release
- 크로스 프로바이더 쿼터 통합 뷰 (TokenTracker 벤치마크)

## 파이프라인 규칙

```
poc   실험장. 커밋 자유. 깨져도 됨.
 └─PR→ dev   보강. CI(node --test) 그린 필수. 셀프리뷰.
        └─PR→ qa    검수. 실사용 E2E 체크리스트 통과.
               └─PR→ prod  릴리스. push 시 GitHub Release 자동.
```

- 브랜치는 이미 존재: poc / dev / qa / prod (+ main = prod 미러)
- CI: .github/workflows/ci.yml — 모든 push/PR 에 node --test
- 릴리스: .github/workflows/release.yml — prod push 시 태그+Release

## 결정 기록 (ADR 요약)

| # | 결정 | 이유 |
|---|---|---|
| 1 | 하이브리드 데이터 평면 (푸시=라이브, 파일=히스토리만) | Headrm 사망 원인 회피, 과거 데이터는 유지 |
| 2 | 내부 포맷 코드는 adapters/ 한 파일 | 포맷 변경 시 수리 범위 최소화, 제품화 시 어댑터만 교체 |
| 3 | 의존성 0, node:sqlite | AI Refrigerator 와 동일 규칙. 설치 마찰 제로 |
| 4 | 멀티플렉싱 tmux 위임 | 터미널 멀티플렉서 재발명 금지 (ponytail) |
| 5 | core/web/tui 분리, API 계약 고정 | 웹·TUI 동일 데이터, 병렬 개발 가능 |
| 6 | collector 50ms 예산 fire-and-forget | 관측 도구가 관측 대상을 느리게 하면 실격 |
| 7 | 설치기는 머지+백업+dry-run | 사용자 settings.json 파손은 신뢰 즉사 |
