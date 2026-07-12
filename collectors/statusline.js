#!/usr/bin/env node
// Statusline collector: forward metrics to sauron, then chain the user's real
// statusline (output preserved). A sauron failure must NEVER break the statusline.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const input = await new Promise((res) => {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => res(Buffer.concat(chunks)));
  process.stdin.on('error', () => res(Buffer.concat(chunks)));
});

let j = {};
try { j = JSON.parse(input.toString('utf8')) || {}; } catch {}

// fire-and-forget POST (budget: 50ms)
try {
  const rl = (x) => x && { used_pct: x.used_percentage, resets_at: x.resets_at };
  const cw = j.context_window;
  const body = {
    sessionId: j.session_id,
    ts: Date.now(),
    model: j.model && { id: j.model.id, display_name: j.model.display_name },
    cost: j.cost && { total_cost_usd: j.cost.total_cost_usd, total_duration_ms: j.cost.total_duration_ms },
    context: cw && {
      used_pct: cw.used_percentage,
      size: cw.context_window_size,
      input_tokens: cw.total_input_tokens,
      output_tokens: cw.total_output_tokens,
    },
    rate: j.rate_limits && { five_hour: rl(j.rate_limits.five_hour), seven_day: rl(j.rate_limits.seven_day) },
    cwd: j.cwd,
    project_dir: j.workspace?.project_dir,
    // branch omitted: not a documented statusline field — guessing spellings here
    // would breach the adapters/ quarantine (DESIGN.md §1)
  };
  const port = process.env.SAURON_PORT || 4870;
  await fetch(`http://127.0.0.1:${port}/ingest/statusline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50),
  });
} catch {}

// chain the user's original statusline, or print a minimal fallback line
try {
  let chain = null;
  try {
    const home = process.env.SAURON_HOME || join(homedir(), '.sauron');
    chain = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).chainStatusline || null;
  } catch {}
  if (chain) {
    const child = spawn(chain, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error', () => {});
    child.stdin.end(input); // same bytes Claude gave us
    await new Promise((res) => { child.on('close', res); child.on('error', res); });
  } else {
    const model = j.model?.display_name || j.model?.id || 'claude';
    process.stdout.write(`${model} | ctx ${j.context_window?.used_percentage ?? '?'}%\n`);
  }
} catch {
  process.stdout.write('claude | ctx ?%\n');
}
process.exit(0);
