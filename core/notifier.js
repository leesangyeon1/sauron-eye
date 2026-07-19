import { execFile } from 'node:child_process';

// needs_input transition → macOS notification, so a waiting session never sits
// unnoticed behind other windows. Fires only on ENTERING needs_input (no spam),
// works regardless of which surface launched the session. Off outside darwin,
// off with SAURON_NOTIFY=0.
const sanitize = (s) => String(s ?? '').replace(/[^\w\s./:@⎇-]/g, '').slice(0, 80);

export function createNotifier(registry, { platform = process.platform, exec = execFile } = {}) {
  if (platform !== 'darwin' || process.env.SAURON_NOTIFY === '0') return () => {};
  const last = new Map(); // sessionId -> last seen state
  return registry.subscribe(({ type, data }) => {
    if (type !== 'session' || !data?.sessionId) return;
    const prev = last.get(data.sessionId);
    last.set(data.sessionId, data.state);
    if (data.state !== 'needs_input' || prev === 'needs_input') return;
    const name = sanitize(data.name) || (data.sessionId || '').slice(0, 8);
    const dir = sanitize((data.cwd || '').split('/').filter(Boolean).pop());
    const body = `${name}${dir ? ` (${dir})` : ''} — waiting for input`;
    // osascript arg array, sanitized body: no quotes/backslashes survive sanitize()
    exec('osascript', ['-e', `display notification "${body}" with title "Sauron Eye"`], () => {});
  });
}
