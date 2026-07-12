// ⚠️ Quarantine (DESIGN.md §1): only file allowed to read Gemini-internal files (~/.gemini).
// Expected to break on Gemini CLI updates; best effort, never throws — {installed:false} / [].
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

const geminiDir = () => join(homedir(), '.gemini');
// async so probes never block the daemon's event loop
const run = (cmd, args) => new Promise((res) => { try { execFile(cmd, args, { timeout: 500 }, (err, out) => res(err ? null : String(out))); } catch { res(null); } });
const onPath = async (bin) => (await run('which', [bin])) !== null;

export async function detect() {
  try {
    if (!existsSync(geminiDir()) && !(await onPath('gemini'))) return { installed: false };
    const out = { installed: true };
    const v = ((await run('gemini', ['--version'])) ?? '').trim();
    if (v) out.version = v;
    return out;
  } catch { return { installed: false }; }
}

export async function backfillSessions() {
  try {
    const tmp = join(geminiDir(), 'tmp'); // tmp/<project-hash>/{chats/*.json, logs.json}
    const out = [];
    for (const dir of readdirSync(tmp)) {
      try {
        let found = false;
        const chats = join(tmp, dir, 'chats');
        try {
          for (const f of readdirSync(chats)) {
            if (!f.endsWith('.json')) continue;
            out.push({
              sessionId: f.slice(0, -'.json'.length),
              provider: 'gemini',
              lastSeen: statSync(join(chats, f)).mtimeMs,
              source: 'history',
            });
            found = true;
          }
        } catch {}
        if (!found) {
          // ponytail: no chats dir → project hash + logs.json mtime stands in for a session
          const st = statSync(join(tmp, dir, 'logs.json'));
          out.push({ sessionId: dir, provider: 'gemini', lastSeen: st.mtimeMs, source: 'history' });
        }
      } catch {}
    }
    out.sort((a, b) => b.lastSeen - a.lastSeen);
    return out.slice(0, 100); // cap: 100 newest
  } catch { return []; }
}
