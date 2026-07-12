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

function activityText(a) {
  if (!a || typeof a !== 'object') return '-';
  const agent = (Array.isArray(a.agents) ? a.agents : []).find((g) => g && g.endedAt == null && g.startedAt);
  const tool = (Array.isArray(a.openTools) ? a.openTools : []).at(-1);
  // open agent beats a bare open "Task" tool (same thing, more info)
  if (tool?.name && !(tool.name === 'Task' && agent)) return `${tool.name} ${ago(tool.startedAt)}`;
  if (agent) return `Task:${agent.type ?? '?'} ${ago(agent.startedAt)}`;
  const sk = (Array.isArray(a.skills) ? a.skills : []).length;
  const mc = (Array.isArray(a.mcpServers) ? a.mcpServers : []).length;
  return sk || mc ? `${sk}sk ${mc}mcp` : '-';
}

function groupHeader(g, width) {
  const u = g?.usage ?? {};
  let t = `── ${g?.label ?? g?.provider ?? '?'}`;
  const p5 = u.rate5h?.usedPct, p7 = u.rate7d?.usedPct;
  if (p5 != null || p7 != null) t += ` · 5h ${p5 ?? '?'}% · 7d ${p7 ?? '?'}%`;
  if (g?.installed === false) t += ' · not installed';
  t += ' ';
  return '\x1b[1m' + (t + '─'.repeat(Math.max(0, width - t.length))).slice(0, width) + RESET;
}

// column widths: [STATE, NAME/ID, MODEL, ACTIVITY, COST, CTX%, BRANCH, LAST]; CWD gets the rest
const COLS = [12, 20, 10, 16, 8, 5, 12, 6];

function rowText(s, cwdW) {
  return [
    pad(s.state, COLS[0]),
    pad(s.name || s.sessionId, COLS[1]),
    pad(s.model, COLS[2]),
    pad(activityText(s.activity), COLS[3]),
    pad(s.costUsd != null ? `$${Number(s.costUsd).toFixed(2)}` : '', COLS[4]),
    pad(s.contextPct != null ? `${s.contextPct}%` : '', COLS[5]),
    pad(s.gitBranch, COLS[6]),
    pad(ago(s.lastSeen), COLS[7]),
    pad(s.cwd, cwdW),
  ].join(' ');
}

function renderFrame({ rows, sessions, selected, footerMsg, down }, width) {
  const lines = [];
  const cwdW = Math.max(8, width - COLS.reduce((a, b) => a + b + 1, 0) - 1);
  const n = sessions.length;
  lines.push(`👁 sauron | ${n} session${n === 1 ? '' : 's'}`.slice(0, width));
  if (down) lines.push('', '\x1b[1;31m  daemon not running — sauron start\x1b[0m', '');
  const head = ['STATE', 'NAME/ID', 'MODEL', 'ACTIVITY', 'COST', 'CTX%', 'BRANCH', 'LAST']
    .map((h, i) => pad(h, COLS[i])).join(' ') + ' ' + pad('CWD', cwdW);
  lines.push('\x1b[4m' + head.slice(0, width) + RESET);
  for (const r of rows) {
    if (r.header) { lines.push(groupHeader(r.group, width)); continue; }
    const s = r.session;
    const color = STATE_COLOR[s.state] ?? '';
    const inv = r.idx === selected ? '\x1b[7m' : '';
    lines.push(inv + color + rowText(s, cwdW).slice(0, width) + RESET);
  }
  lines.push('', '↑↓/jk select · s spawn · c copy resume · r refresh · q quit'.slice(0, width));
  if (footerMsg) lines.push(footerMsg.slice(0, width));
  return lines;
}

export async function runTui({ port = 4870, once = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const state = { rows: [], sessions: [], selected: 0, footerMsg: '', down: false };

  async function refresh() {
    let g;
    try {
      g = await fetchJson(`${base}/api/groups`);
    } catch {
      state.down = true;
      return;
    }
    state.down = false;
    const rows = [], sessions = [];
    for (const grp of Array.isArray(g?.groups) ? g.groups : []) {
      rows.push({ header: true, group: grp });
      for (const s of Array.isArray(grp?.sessions) ? grp.sessions : []) {
        if (!s || typeof s !== 'object') continue;
        rows.push({ session: s, idx: sessions.length }); // headers carry no idx → not selectable
        sessions.push(s);
      }
    }
    state.rows = rows;
    state.sessions = sessions;
    state.selected = Math.min(state.selected, Math.max(0, sessions.length - 1));
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
  process.on('exit', cleanup);
  process.on('uncaughtException', (err) => { cleanup(); throw err; }); // restore terminal, then die loudly

  function paint() {
    const width = out.columns || 120;
    // repaint from home + clear-to-eol per line, clear rest once (less flicker than full clear)
    const body = renderFrame(state, width).map((l) => l + '\x1b[K').join('\n');
    out.write('\x1b[H' + body + '\x1b[J');
  }

  // one bad API payload must never take down the alt screen
  async function tick() {
    try {
      await refresh();
      paint();
    } catch (e) {
      state.footerMsg = `tick error: ${String(e?.message ?? e)}`;
      try { paint(); } catch { /* keep alt screen alive */ }
    }
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
    // sessionId is server-supplied and lands in a shell via paste — allowlist it
    if (!/^[A-Za-z0-9_-]+$/.test(s.sessionId ?? '')) {
      state.footerMsg = 'unsafe sessionId — not copied';
      paint();
      return;
    }
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
    try {
      if (str === 'q' || (key.ctrl && key.name === 'c')) { cleanup(); process.exit(0); }
      state.footerMsg = '';
      if (key.name === 'up' || str === 'k') state.selected = Math.max(0, state.selected - 1);
      else if (key.name === 'down' || str === 'j') state.selected = Math.min(state.sessions.length - 1, state.selected + 1);
      else if (str === 'r') await refresh();
      else if (str === 's') spawnSession();
      else if (str === 'c') { copyResume(); return; }
      paint();
    } catch { /* never crash the alt screen on input */ }
  });

  await tick();
  timer = setInterval(tick, POLL_MS);
}
