// tui/tui.js — sauron TUI ("하는 곳"). Zero deps, plain ANSI.
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const POLL_MS = 2000; // ponytail: polling, SSE later if flicker matters
const STATE_COLOR = {
  working: '\x1b[32m',
  idle: '\x1b[36m',
  needs_input: '\x1b[1;33m',
  stale: '\x1b[2m',
  ended: '\x1b[2;9m',
};
const RESET = '\x1b[0m';

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function bar(pct) {
  const n = Math.max(0, Math.min(4, Math.round((pct ?? 0) / 25)));
  return '▓'.repeat(n) + '░'.repeat(4 - n);
}

function until(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!iso || Number.isNaN(ms) || ms < 0) return '?';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h${m}m` : `${m}m`;
}

function ago(ts) {
  if (!ts) return '?';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function pad(str, w) {
  str = String(str ?? '');
  return str.length > w ? str.slice(0, w - 1) + '…' : str.padEnd(w, ' ');
}

function headerLine(quota, count) {
  const c = quota?.providers?.claude;
  let q = 'quota: n/a';
  if (c) {
    const r5 = c.rate5h ?? {}, r7 = c.seven_day ?? c.rate7d ?? {};
    q = `claude 5h ${bar(r5.usedPct ?? r5.used_pct)} ${r5.usedPct ?? r5.used_pct ?? '?'}% (resets ${until(r5.resetsAt ?? r5.resets_at)})` +
        ` | 7d ${bar(r7.usedPct ?? r7.used_pct)} ${r7.usedPct ?? r7.used_pct ?? '?'}%`;
  }
  return `👁 sauron | ${q} | ${count} session${count === 1 ? '' : 's'}`;
}

// column widths: [STATE, NAME/ID, MODEL, COST, CTX%, BRANCH, LAST]; CWD gets the rest
const COLS = [12, 22, 10, 8, 5, 14, 6];

function rowText(s, cwdW) {
  return [
    pad(s.state, COLS[0]),
    pad(s.name || s.sessionId, COLS[1]),
    pad(s.model, COLS[2]),
    pad(s.costUsd != null ? `$${Number(s.costUsd).toFixed(2)}` : '', COLS[3]),
    pad(s.contextPct != null ? `${s.contextPct}%` : '', COLS[4]),
    pad(s.gitBranch, COLS[5]),
    pad(ago(s.lastSeen), COLS[6]),
    pad(s.cwd, cwdW),
  ].join(' ');
}

function renderFrame({ sessions, quota, selected, footerMsg, down }, width) {
  const lines = [];
  const cwdW = Math.max(8, width - COLS.reduce((a, b) => a + b + 1, 0) - 1);
  lines.push(headerLine(quota, sessions.length).slice(0, width));
  if (down) lines.push('', '\x1b[1;31m  daemon not running — sauron start\x1b[0m', '');
  const head = ['STATE', 'NAME/ID', 'MODEL', 'COST', 'CTX%', 'BRANCH', 'LAST']
    .map((h, i) => pad(h, COLS[i])).join(' ') + ' ' + pad('CWD', cwdW);
  lines.push('\x1b[4m' + head.slice(0, width) + RESET);
  sessions.forEach((s, i) => {
    const color = STATE_COLOR[s.state] ?? '';
    const inv = i === selected ? '\x1b[7m' : '';
    lines.push(inv + color + rowText(s, cwdW).slice(0, width) + RESET);
  });
  lines.push('', '↑↓/jk select · s spawn · c copy resume · r refresh · q quit'.slice(0, width));
  if (footerMsg) lines.push(footerMsg.slice(0, width));
  return lines;
}

export async function runTui({ port = 4870, once = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const state = { sessions: [], quota: null, selected: 0, footerMsg: '', down: false };

  async function refresh() {
    try {
      const [s, q] = await Promise.all([fetchJson(`${base}/api/sessions`), fetchJson(`${base}/api/quota`)]);
      state.sessions = Array.isArray(s?.sessions) ? s.sessions : [];
      state.quota = q;
      state.down = false;
      state.selected = Math.min(state.selected, Math.max(0, state.sessions.length - 1));
    } catch {
      state.down = true;
    }
  }

  if (once) {
    await refresh();
    const width = process.stdout.columns || 120;
    process.stdout.write(renderFrame(state, width).join('\n') + '\n');
    return;
  }

  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
  let closed = false;
  let timer;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l'); // cursor show, restore screen
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  function paint() {
    const width = out.columns || 120;
    // repaint from home + clear-to-eol per line, clear rest once (less flicker than full clear)
    const body = renderFrame(state, width).map((l) => l + '\x1b[K').join('\n');
    out.write('\x1b[H' + body + '\x1b[J');
  }

  function spawnSession() {
    if (process.env.TMUX) {
      spawn('tmux', ['split-window', '-h', 'claude'], { stdio: 'ignore', detached: true }).unref();
      state.footerMsg = 'spawned claude in tmux split';
    } else if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0) {
      state.footerMsg = 'run inside tmux for auto-split';
    } else {
      state.footerMsg = 'run: claude';
    }
  }

  function copyResume() {
    const s = state.sessions[state.selected];
    if (!s) return;
    const cmd = `claude --resume ${s.sessionId}`;
    if (process.platform === 'darwin') {
      try {
        const p = spawn('pbcopy');
        p.stdin.end(cmd);
        state.footerMsg = `copied: ${cmd}`;
        paint();
        return;
      } catch { /* fall through */ }
    }
    state.footerMsg = cmd;
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', async (str, key = {}) => {
    if (str === 'q' || (key.ctrl && key.name === 'c')) { cleanup(); process.exit(0); }
    state.footerMsg = '';
    if (key.name === 'up' || str === 'k') state.selected = Math.max(0, state.selected - 1);
    else if (key.name === 'down' || str === 'j') state.selected = Math.min(state.sessions.length - 1, state.selected + 1);
    else if (str === 'r') await refresh();
    else if (str === 's') spawnSession();
    else if (str === 'c') { copyResume(); return; }
    paint();
  });

  await refresh();
  paint();
  timer = setInterval(async () => { await refresh(); paint(); }, POLL_MS);
}
