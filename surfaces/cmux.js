import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// cmux surface adapter (syntax source: manaflow-ai/cmux docs/cli-contract.md).
// One workspace per worktree — cmux's vertical tabs show git branch/cwd natively.
// Same quarantine contract as tmux.js: never throw, degrade to { ok:false, hint }.
const execP = promisify(execFile);

export async function detect() {
  try {
    const { stdout } = await execP('cmux', ['--version']);
    // binary present ≠ app running: socket commands need the app. ping answers that.
    let running = false;
    try { await execP('cmux', ['ping']); running = true; } catch { /* app closed */ }
    return { available: true, running, version: stdout.trim() };
  } catch {
    return { available: false, running: false };
  }
}

export async function launch({ cwd, command = 'claude', title } = {}) {
  const args = ['--json', 'new-workspace', '--cwd', cwd, '--command', command];
  if (title) args.push('--description', title);
  try {
    const { stdout } = await execP('cmux', args);
    let id = null;
    try {
      const j = JSON.parse(stdout);
      id = j?.workspaceId ?? j?.workspace?.id ?? j?.id ?? null; // shape undocumented — best-effort
    } catch { /* non-JSON success output is fine */ }
    return { ok: true, note: `cmux workspace${id ? ' ' + id : ''}` };
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).trim(); // || not ??: ENOENT has stderr === ''
    const hint = err?.code === 'ENOENT' ? 'cmux not installed (brew install --cask cmux)'
      : /socket|connect|refused/i.test(msg) ? 'cmux app not running — open cmux first'
      : msg;
    return { ok: false, hint };
  }
}
