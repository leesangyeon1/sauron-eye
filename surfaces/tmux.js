import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Execution surface adapter (README §4.3 contract): never throw, degrade to { ok:false, hint }.
// Same quarantine idea as adapters/ — all tmux knowledge lives in this one file.
const execP = promisify(execFile);

export async function detect() {
  try {
    const { stdout } = await execP('tmux', ['-V']);
    return { available: true, version: stdout.trim() };
  } catch {
    return { available: false };
  }
}

export async function launch({ cwd, command = 'claude', title = 'sauron', pane } = {}) {
  // caller's pane known (CLI passes $TMUX_PANE) → split there; else detached session + attach hint
  if (pane) {
    try {
      await execP('tmux', ['split-window', '-t', pane, '-c', cwd, command]);
      return { ok: true, note: `tmux split in pane ${pane}` };
    } catch { /* pane gone or no attached client — fall through to a detached session */ }
  }
  const name = `sauron-${title}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60);
  const session = async (args) => {
    const { stdout } = await execP('tmux', ['new-session', '-d', '-P', '-F', '#{session_name}', ...args, '-c', cwd, command]);
    const actual = stdout.trim() || name;
    return { ok: true, note: `tmux session ${actual}`, hint: `tmux attach -t ${actual}` };
  };
  try {
    return await session(['-s', name]);
  } catch (err) {
    if (/duplicate session/.test(String(err?.stderr ?? err))) {
      try { return await session([]); } catch (err2) { err = err2; } // let tmux auto-name
    }
    return { ok: false, hint: String(err?.stderr || err?.message || err).trim() }; // || not ??: ENOENT has stderr === ''
  }
}
