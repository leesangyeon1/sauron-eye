// tui/tui.js — sauron TUI ("하는 곳"). Zero deps, plain ANSI.
// views: sessions (default) ⇄ worktrees (`w`). `s` spawns a worktree via the daemon API.
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const POLL_MS = 2000; // ponytail: polling, SSE later if flicker matters
const STATE_COLOR = {
  working: '\x1b[32m',
  idle: '\x1b[36m',
  needs_input: '\x1b[1;33m',
  stale: '\x1b[2m',
  ended: '\x1b[2;9m',
};
const WT_COLOR = {
  provisioning: '\x1b[36m',
  active: '\x1b[32m',
  'pending-cleanup': '\x1b[33m',
  clean: '\x1b[2m',
  dirty: '\x1b[31m',
};
const RESET = '\x1b[0m';

async function fetchJson(url, { method = 'GET', body, timeout = 1000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok && res.headers.get('content-type')?.includes('json') !== true) throw new Error(`HTTP ${res.status}`);
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
// worktree view: [STATUS, BRANCH, SESSION, PRESET, AGE]; PATH gets the rest
const WCOLS = [16, 26, 12, 14, 5];

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

function wtRowText(w, pathW) {
  return [
    pad(w.status, WCOLS[0]),
    pad(w.branch, WCOLS[1]),
    pad(w.session?.state ?? (w.sessionId ? 'ended' : '-'), WCOLS[2]),
    pad(w.presetId ?? '', WCOLS[3]),
    pad(ago(w.createdAt), WCOLS[4]),
    pad(w.worktreePath, pathW),
  ].join(' ');
}

function renderFrame(state, width) {
  const lines = [];
  if (state.view === 'worktrees') {
    const pathW = Math.max(8, width - WCOLS.reduce((a, b) => a + b + 1, 0) - 1);
    const n = state.wts.length;
    lines.push(`👁 sauron worktrees | ${n}`.slice(0, width));
    if (state.down) lines.push('', '\x1b[1;31m  daemon not running — sauron start\x1b[0m', '');
    const head = ['STATUS', 'BRANCH', 'SESSION', 'PRESET', 'AGE'].map((h, i) => pad(h, WCOLS[i])).join(' ') + ' ' + pad('PATH', pathW);
    lines.push('\x1b[4m' + head.slice(0, width) + RESET);
    state.wts.forEach((w, i) => {
      const color = WT_COLOR[w.status] ?? '';
      const inv = i === state.wsel ? '\x1b[7m' : '';
      lines.push(inv + color + wtRowText(w, pathW).slice(0, width) + RESET);
    });
    if (!n) lines.push('\x1b[2m  (없음 — s 로 spawn)\x1b[0m');
    lines.push('', 'w sessions · ↑↓/jk · s spawn · g gc(dry) · G gc --force · x rm · r refresh · q quit'.slice(0, width));
  } else {
    const cwdW = Math.max(8, width - COLS.reduce((a, b) => a + b + 1, 0) - 1);
    const n = state.sessions.length;
    lines.push(`👁 sauron | ${n} session${n === 1 ? '' : 's'}`.slice(0, width));
    if (state.down) lines.push('', '\x1b[1;31m  daemon not running — sauron start\x1b[0m', '');
    const head = ['STATE', 'NAME/ID', 'MODEL', 'ACTIVITY', 'COST', 'CTX%', 'BRANCH', 'LAST']
      .map((h, i) => pad(h, COLS[i])).join(' ') + ' ' + pad('CWD', cwdW);
    lines.push('\x1b[4m' + head.slice(0, width) + RESET);
    for (const r of state.rows) {
      if (r.header) { lines.push(groupHeader(r.group, width)); continue; }
      const s = r.session;
      const color = STATE_COLOR[s.state] ?? '';
      const inv = r.idx === state.selected ? '\x1b[7m' : '';
      lines.push(inv + color + rowText(s, cwdW).slice(0, width) + RESET);
    }
    lines.push('', '↑↓/jk select · w worktrees · s spawn · c copy resume · r refresh · q quit'.slice(0, width));
  }
  if (state.input) lines.push(`\x1b[1m${state.input.label}\x1b[0m ${state.input.value}▏`.slice(0, width));
  else if (state.footerMsg) lines.push(state.footerMsg.slice(0, width));
  return lines;
}

export async function runTui({ port = 4870, once = false } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const state = {
    rows: [], sessions: [], selected: 0, footerMsg: '', down: false,
    view: 'sessions', wts: [], wsel: 0, input: null,
  };

  async function refresh() {
    try {
      if (state.view === 'worktrees') {
        const j = await fetchJson(`${base}/api/worktree/list`);
        state.wts = Array.isArray(j?.worktrees) ? j.worktrees : [];
        state.wsel = Math.min(state.wsel, Math.max(0, state.wts.length - 1));
      } else {
        const g = await fetchJson(`${base}/api/groups`);
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
      state.down = false;
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
    if (state.input) return; // don't repaint over an open prompt
    try {
      await refresh();
      paint();
    } catch (e) {
      state.footerMsg = `tick error: ${String(e?.message ?? e)}`;
      try { paint(); } catch { /* keep alt screen alive */ }
    }
  }

  // single-line prompt in the footer; Enter=commit, Esc=cancel(null)
  function ask(label, def = '') {
    return new Promise((resolve) => {
      state.input = { label, value: def, resolve };
      paint();
    });
  }

  async function spawnFlow() {
    const sel = state.sessions[state.selected];
    const repo = await ask('repo path:', state.view === 'sessions' && sel?.cwd ? sel.cwd : process.cwd());
    if (repo == null || !repo.trim()) { state.footerMsg = 'spawn 취소'; return; }
    const preset = await ask('preset id (empty=none):', '');
    if (preset == null) { state.footerMsg = 'spawn 취소'; return; }
    state.footerMsg = 'spawning…';
    paint();
    try {
      const r = await fetchJson(`${base}/api/worktree/create`, {
        method: 'POST', timeout: 90_000,
        body: {
          repoPath: repo.trim(),
          presetId: preset.trim() || undefined,
          paneTarget: process.env.TMUX_PANE, // TUI inside tmux → split next to it
        },
      });
      if (!r.ok) { state.footerMsg = `spawn 실패: ${r.error}`; return; }
      const extra = (r.warnings ?? [])[0] ?? (r.surface?.ok ? r.surface.note : `run: ${r.command}`);
      state.footerMsg = `${r.reused ? 'reused' : 'spawned'} ${r.branch} · ${extra}`;
      if (state.view === 'worktrees') await refresh();
    } catch (e) {
      state.footerMsg = `spawn 실패: ${String(e?.message ?? e)}`;
    }
  }

  async function gcFlow(force) {
    if (force) {
      const yn = await ask('clean worktree 실제 삭제 (dirty 는 보존) [y/N]:');
      if ((yn ?? '').trim().toLowerCase() !== 'y') { state.footerMsg = 'gc 취소'; return; }
    }
    try {
      const rep = await fetchJson(`${base}/api/worktree/gc`, { method: 'POST', timeout: 60_000, body: { dryRun: !force } });
      if (rep.error) { state.footerMsg = `gc 실패: ${rep.error}`; return; }
      const n = (k) => rep[k]?.length ?? 0;
      state.footerMsg = `gc: ${force ? `removed ${n('removed')}` : `clean ${n('clean')}`} · dirty ${n('dirty')} · missing ${n('missing')} · errors ${n('errors')}`;
      await refresh();
    } catch (e) {
      state.footerMsg = `gc 실패: ${String(e?.message ?? e)}`;
    }
  }

  async function rmFlow() {
    const w = state.wts[state.wsel];
    if (!w) return;
    const yn = await ask(`rm ${w.branch} (${w.status}) [y/N]:`);
    if ((yn ?? '').trim().toLowerCase() !== 'y') { state.footerMsg = 'rm 취소'; return; }
    const del = (force) => fetchJson(`${base}/api/worktree/${encodeURIComponent(w.id)}`, { method: 'DELETE', timeout: 30_000, body: { force } });
    try {
      let r = await del(false);
      if (!r.ok && /dirty/.test(r.error ?? '')) {
        const f = await ask('미커밋 변경 있음 — 강제 삭제? 유실됩니다 [y/N]:');
        if ((f ?? '').trim().toLowerCase() !== 'y') { state.footerMsg = 'rm 취소'; return; }
        r = await del(true);
      }
      state.footerMsg = r.ok ? `removed — ${r.note ?? ''}` : `rm 실패: ${r.error}`;
      await refresh();
    } catch (e) {
      state.footerMsg = `rm 실패: ${String(e?.message ?? e)}`;
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
      // prompt mode swallows every key until Enter/Esc
      if (state.input) {
        const inp = state.input;
        if (key.name === 'return') { state.input = null; inp.resolve(inp.value); }
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { state.input = null; inp.resolve(null); }
        else if (key.name === 'backspace') { inp.value = inp.value.slice(0, -1); paint(); }
        else if (str && !key.ctrl && !key.meta && str >= ' ') { inp.value += str; paint(); }
        return;
      }
      if (str === 'q' || (key.ctrl && key.name === 'c')) { cleanup(); process.exit(0); }
      state.footerMsg = '';
      if (str === 'w') { state.view = state.view === 'worktrees' ? 'sessions' : 'worktrees'; await refresh(); }
      else if (key.name === 'up' || str === 'k') {
        if (state.view === 'worktrees') state.wsel = Math.max(0, state.wsel - 1);
        else state.selected = Math.max(0, state.selected - 1);
      } else if (key.name === 'down' || str === 'j') {
        if (state.view === 'worktrees') state.wsel = Math.min(state.wts.length - 1, state.wsel + 1);
        else state.selected = Math.min(state.sessions.length - 1, state.selected + 1);
      }
      else if (str === 'r') await refresh();
      else if (str === 's') await spawnFlow();
      else if (str === 'g' && state.view === 'worktrees') await gcFlow(false);
      else if (str === 'G' && state.view === 'worktrees') await gcFlow(true);
      else if (str === 'x' && state.view === 'worktrees') await rmFlow();
      else if (str === 'c' && state.view === 'sessions') { copyResume(); return; }
      paint();
    } catch { /* never crash the alt screen on input */ }
  });

  await tick();
  timer = setInterval(tick, POLL_MS);
}
