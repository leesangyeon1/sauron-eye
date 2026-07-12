#!/usr/bin/env node
// Hook collector: lifecycle event → POST /ingest/hook. Fire-and-forget,
// 50ms budget, failures ignored — never slows Claude down.
// events: session_start session_end stop notification user_prompt_submit
//         pre_tool_use post_tool_use subagent_stop
const event = process.argv[2] || 'unknown';

let raw = '';
try { for await (const c of process.stdin) raw += c; } catch {}

let j = {};
try { j = JSON.parse(raw) || {}; } catch {}

// meta only for tool events; tool_input capped at 512 bytes (API.md v2)
let meta;
if (['pre_tool_use', 'post_tool_use', 'subagent_stop'].includes(event)) {
  meta = { tool_name: j.tool_name, tool_use_id: j.tool_use_id };
  try {
    const s = JSON.stringify(j.tool_input);
    if (s !== undefined) {
      if (Buffer.byteLength(s) > 512) {
        // keep the small identifying keys the registry needs (Skill/Task tracking),
        // but only short strings — a huge Bash `command` stays dropped (cap intact)
        meta.tool_input = { truncated: true };
        for (const k of ['skill', 'name', 'command', 'subagent_type']) {
          const v = j.tool_input?.[k];
          if (typeof v === 'string' && v.length <= 128) meta.tool_input[k] = v;
        }
      } else meta.tool_input = j.tool_input;
    }
  } catch {}
}

try {
  const port = process.env.SAURON_PORT || 4870;
  await fetch(`http://127.0.0.1:${port}/ingest/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: j.session_id, ts: Date.now(), event, cwd: j.cwd, provider: 'claude', meta }),
    // ponytail: cold-start fetch can exceed 50ms on some machines; env knob for tests/tuning
    signal: AbortSignal.timeout(Number(process.env.SAURON_HOOK_TIMEOUT_MS) || 50),
  });
} catch {}
process.exit(0);
