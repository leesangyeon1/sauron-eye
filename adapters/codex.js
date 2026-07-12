// ⚠️ Quarantine (DESIGN.md §1): only file allowed to read Codex-internal files (~/.codex).
// Expected to break on Codex updates; best effort, never throws — {installed:false} / [].
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

const codexDir = () => join(homedir(), '.codex');
// async so probes never block the daemon's event loop
const run = (cmd, args) => new Promise((res) => { try { execFile(cmd, args, { timeout: 500 }, (err, out) => res(err ? null : String(out))); } catch { res(null); } });
const onPath = async (bin) => (await run('which', [bin])) !== null;

export async function detect() {
  try {
    if (!existsSync(codexDir()) && !(await onPath('codex'))) return { installed: false };
    const out = { installed: true };
    const v = ((await run('codex', ['--version'])) ?? '').trim();
    if (v) out.version = v;
    return out;
  } catch { return { installed: false }; }
}

export async function backfillSessions() {
  try {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 4) return; // ponytail: sessions/YYYY/MM/DD/*.jsonl — 4 levels is plenty
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith('.jsonl')) {
          try {
            out.push({
              sessionId: e.name.slice(0, -'.jsonl'.length),
              provider: 'codex',
              lastSeen: statSync(p).mtimeMs,
              source: 'history',
            });
          } catch {}
        }
      }
    };
    walk(join(codexDir(), 'sessions'), 0);
    out.sort((a, b) => b.lastSeen - a.lastSeen);
    return out.slice(0, 100); // cap: 100 newest
  } catch { return []; }
}
