#!/usr/bin/env node
// Hook collector: lifecycle event → POST /ingest/hook. Fire-and-forget,
// 50ms budget, failures ignored — never slows Claude down.
const event = process.argv[2] || 'unknown';

let raw = '';
try { for await (const c of process.stdin) raw += c; } catch {}

let j = {};
try { j = JSON.parse(raw) || {}; } catch {}

try {
  const port = process.env.SAURON_PORT || 4870;
  await fetch(`http://127.0.0.1:${port}/ingest/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: j.session_id, ts: Date.now(), event, cwd: j.cwd, meta: {} }),
    signal: AbortSignal.timeout(50),
  });
} catch {}
process.exit(0);
