// ⚠️ Only file allowed to know Claude-internal formats. Expected to break; keep isolated.
// Every export: best effort, never throws — [] / null on any failure.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

const claudeDir = () => process.env.SAURON_CLAUDE_DIR || join(homedir(), '.claude');

export async function detect() {
  try {
    if (existsSync(claudeDir())) return { installed: true };
    // async so the probe never blocks the daemon's event loop
    return await new Promise((res) => {
      try { execFile('which', ['claude'], { timeout: 500 }, (err) => res({ installed: !err })); } catch { res({ installed: false }); }
    });
  } catch { return { installed: false }; }
}

export async function backfillSessions() {
  try {
    const projects = join(claudeDir(), 'projects');
    const out = [];
    for (const dir of readdirSync(projects)) {
      let files;
      try { files = readdirSync(join(projects, dir)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const st = statSync(join(projects, dir, f));
          out.push({
            sessionId: f.slice(0, -'.jsonl'.length),
            name: null,
            // ponytail: dir name is Claude's escaped cwd ("-Users-x-proj"); un-escaping is
            // lossy (dashes ambiguous) — keep the escaped name as a cwd hint
            cwd: dir,
            lastSeen: st.mtimeMs,
            source: 'history',
          });
        } catch {}
      }
    }
    out.sort((a, b) => b.lastSeen - a.lastSeen);
    return out.slice(0, 200); // cap: 200 newest
  } catch { return []; }
}

export async function sessionName(id) {
  try {
    const dir = join(claudeDir(), 'sessions');
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (j.sessionId === id) return j.name || null;
      } catch {}
    }
    return null;
  } catch { return null; }
}
