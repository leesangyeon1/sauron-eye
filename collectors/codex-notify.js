#!/usr/bin/env node
// Codex `notify` receives ONE JSON arg (argv[2]) per event. As of codex-cli 0.144
// the only event is agent-turn-complete → treat as a stop (turn done → idle).
// Fire-and-forget, 50ms budget, never blocks codex. (Research: only turn-complete;
// session start/end are not emitted, so codex sessions show working↔idle only.)
let j = {};
try { j = JSON.parse(process.argv[2] || '{}') || {}; } catch {}

try {
  const port = process.env.SAURON_PORT || 4870;
  await fetch(`http://127.0.0.1:${port}/ingest/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: j['thread-id'] ?? j.thread_id ?? j.turn_id ?? j['turn-id'],
      ts: Date.now(),
      event: j.type === 'agent-turn-complete' ? 'stop' : 'session_start',
      cwd: j.cwd,
      provider: 'codex',
    }),
    signal: AbortSignal.timeout(Number(process.env.SAURON_HOOK_TIMEOUT_MS) || 50),
  });
} catch {}
process.exit(0);
