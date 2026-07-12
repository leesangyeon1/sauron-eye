// ⚠️ Quarantine (DESIGN.md §1): only file allowed to probe Antigravity-internal locations.
// Best effort, never throws — {installed:false} / [].
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

// async so probes never block the daemon's event loop
const run = (cmd, args) => new Promise((res) => { try { execFile(cmd, args, { timeout: 500 }, (err, out) => res(err ? null : String(out))); } catch { res(null); } });
const onPath = async (bin) => (await run('which', [bin])) !== null;

export async function detect() {
  try {
    const installed = (await onPath('antigravity'))
      || existsSync(join(homedir(), 'Library', 'Application Support', 'Antigravity'));
    return { installed };
  } catch { return { installed: false }; }
}

export async function backfillSessions() {
  // ponytail: no known session store; detect-only until someone needs more
  return [];
}
