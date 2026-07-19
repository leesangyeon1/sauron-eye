#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const cmd = process.argv[2];
const port = Number(process.env.SAURON_PORT) || 4870;

const missing = (what) => {
  console.error(`${what} is not built yet in this checkout.`);
  process.exit(1);
};

// daemon HTTP helper: connection failure = daemon down, one clear message
async function api(method, path, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await r.json();
  } catch {
    console.error(`sauron not running on 127.0.0.1:${port} — run \`sauron start\` first`);
    process.exit(1);
  }
}

// ponytail: best-effort browser launch, ordered by likelihood; URL always printed as fallback
function openAppWindow(url) {
  const ok = (r) => !r.error && r.status === 0;
  const bg = (bin, args) => {
    const p = spawn(bin, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  };
  try {
    if (process.platform === 'darwin') {
      for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser'])
        if (ok(spawnSync('open', ['-na', app, '--args', `--app=${url}`], { stdio: 'ignore' }))) return;
      spawnSync('open', [url], { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      const bin = ['google-chrome', 'chromium']
        .find((b) => ok(spawnSync('which', [b], { stdio: 'ignore' })));
      if (bin) bg(bin, [`--app=${url}`]);
      else bg('xdg-open', [url]);
    } else if (process.platform === 'win32') {
      if (!ok(spawnSync(`start "" chrome --app=${url}`, { shell: true, stdio: 'ignore' })))
        spawnSync(`start "" "${url}"`, { shell: true, stdio: 'ignore' });
    }
  } catch { /* ignore — URL is printed by the caller */ }
}

switch (cmd) {
  case 'start': {
    const { startServer } = await import('../core/server.js');
    const srv = await startServer();
    console.log(`sauron eye open: http://127.0.0.1:${srv.port}`);
    break; // foreground: server keeps the event loop alive
  }
  case 'app': {
    const url = `http://127.0.0.1:${port}`;
    const alive = async () => {
      try {
        const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
        return (await r.json())?.ok === true;
      } catch { return false; }
    };
    if (!(await alive())) {
      spawn(process.execPath, [fileURLToPath(import.meta.url), 'start'], { detached: true, stdio: 'ignore' }).unref();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !(await alive())) await new Promise((r) => setTimeout(r, 200));
    }
    openAppWindow(url);
    console.log(`sauron app: ${url}`);
    break;
  }
  case 'tui': {
    const mod = await import('../tui/tui.js').catch(() => null);
    if (!mod?.runTui) missing('tui (tui/tui.js)');
    await mod.runTui({ port });
    break;
  }
  case 'install':
  case 'uninstall': {
    const mod = await import('../collectors/install.js').catch(() => null);
    if (!mod?.install) missing('collectors (collectors/install.js)');
    if (cmd === 'install') await mod.install({ dryRun: process.argv.includes('--dry-run') });
    else await mod.uninstall();
    break;
  }
  case 'spawn': {
    let parsed;
    try {
      parsed = parseArgs({
        args: process.argv.slice(3),
        allowPositionals: true,
        options: {
        branch: { type: 'string' },
        base: { type: 'string' },
        preset: { type: 'string' },
        via: { type: 'string' },
          swarm: { type: 'string' },
          prompt: { type: 'string' },
          'no-launch': { type: 'boolean' },
        },
      });
    } catch (err) {
      console.error(`invalid arguments: ${err.message}`); // e.g. --swarm -3 (parseArgs treats -3 as an option)
      process.exit(1);
    }
    const { values, positionals } = parsed;
    if (values.via && !['tmux', 'cmux'].includes(values.via)) {
      console.error(`unknown surface "${values.via}" — supported: tmux, cmux`);
      process.exit(1);
    }
    const common = {
      repoPath: resolve(positionals[0] ?? '.'),
      branch: values.branch,
      baseBranch: values.base,
      presetId: values.preset,
      launch: !values['no-launch'],
      paneTarget: process.env.TMUX_PANE, // present iff spawn ran inside tmux → split in place
      via: values.via, // omitted → daemon auto-detects (cmux > tmux)
    };
    if (values.swarm) {
      const r = await api('POST', '/api/swarm/create', { ...common, count: Number(values.swarm), prompt: values.prompt });
      if (!r.ok && !r.members?.length) { console.error(`swarm failed: ${r.error}`); process.exit(1); }
      console.log(`swarm:    ${r.swarmId} (${r.members.length} members)`);
      for (const m of r.members) {
        if (m.ok) console.log(`  ${m.branch.padEnd(36)} ${m.worktreePath}`);
        else console.log(`  FAILED: ${m.error}`);
      }
      const q = r.quota?.claude;
      const hot = (x) => x?.usedPct != null && x.usedPct >= 70;
      if (hot(q?.rate5h) || hot(q?.rate7d)) {
        console.log(`warning:  quota 5h ${q.rate5h?.usedPct ?? '?'}% · 7d ${q.rate7d?.usedPct ?? '?'}% — ${r.members.length} parallel sessions will burn it fast`);
      }
      console.log(`compare:  http://127.0.0.1:${port}/#worktrees → 채택으로 머지`);
      if (!r.ok) process.exit(1);
      break;
    }
    if (values.prompt) console.error('note: --prompt without --swarm is ignored'); // single spawn = interactive session
    const r = await api('POST', '/api/worktree/create', common);
    if (!r.ok) {
      console.error(`spawn failed: ${r.error}`);
      process.exit(1);
    }
    console.log(`worktree: ${r.worktreePath}${r.reused ? ' (reused)' : ''}`);
    console.log(`branch:   ${r.branch} (base ${r.baseBranch})`);
    for (const w of r.warnings ?? []) console.log(`warning:  ${w}`);
    if (r.surface?.ok) console.log(`surface:  ${r.surface.note}${r.surface.hint ? ` — ${r.surface.hint}` : ''}`);
    else console.log(`run:      ${r.command}${r.surface?.hint ? `  (tmux: ${r.surface.hint})` : ''}`);
    break;
  }
  case 'swarm': {
    const sub = process.argv[3];
    if (sub === 'ls') {
      const r = await api('GET', '/api/swarm/list');
      if (r.error) { console.error(r.error); process.exit(1); }
      if (!r.swarms?.length) { console.log('no swarms'); break; }
      for (const s of r.swarms) {
        console.log(`${s.swarmId}  base ${s.baseBranch}  "${(s.prompt ?? '').slice(0, 60)}"`);
        for (const m of s.members) {
          const sess = m.session?.state ?? (m.sessionId ? 'ended' : '-');
          console.log(`  ${m.status.padEnd(16)} ${sess.padEnd(12)} ${m.branch.padEnd(36)} ${m.id}`);
        }
      }
      break;
    }
    if (sub === 'adopt') {
      const winnerId = process.argv[4];
      if (!winnerId || winnerId.startsWith('--')) { console.error('usage: sauron swarm adopt <winner-worktree-id>'); process.exit(1); }
      const r = await api('POST', '/api/swarm/adopt', { winnerId });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(`merged ${r.merged} → ${r.into}`);
      for (const l of r.losersRemoved) console.log(`  removed: ${l.branch}`);
      for (const l of r.losersSkipped) console.log(`  skipped: ${l.branch} — ${l.error}`);
      if (r.branchCleanup?.length) {
        console.log('loser branches kept — delete manually if wanted:');
        for (const c of r.branchCleanup) console.log(`  ${c}`);
      }
      break;
    }
    console.log('usage: sauron swarm <ls|adopt <winner-id>>');
    process.exit(sub ? 1 : 0);
    break;
  }
  case 'worktree': {
    const sub = process.argv[3];
    if (sub === 'ls') {
      const r = await api('GET', '/api/worktree/list');
      if (r.error) { console.error(r.error); process.exit(1); }
      const { worktrees } = r;
      if (!worktrees?.length) { console.log('no worktrees'); break; }
      for (const w of worktrees) {
        const sess = w.session?.state ?? (w.sessionId ? 'ended' : '-');
        console.log(`${w.status.padEnd(16)} ${sess.padEnd(12)} ${w.branch.padEnd(32)} ${w.worktreePath}`);
      }
      break;
    }
    if (sub === 'gc') {
      const force = process.argv.includes('--force');
      const rep = await api('POST', '/api/worktree/gc', { dryRun: !force });
      if (rep.error) { console.error(rep.error); process.exit(1); } // daemon 500 must not read as "nothing pending"
      const line = (w) => `  ${w.branch} — ${w.worktreePath}`;
      if (rep.removed?.length) { console.log('removed:'); rep.removed.forEach((w) => console.log(line(w))); }
      if (rep.clean?.length) {
        console.log(force ? 'clean:' : 'clean (would remove — rerun with --force):');
        rep.clean.forEach((w) => console.log(line(w)));
      }
      if (rep.dirty?.length) {
        console.log('dirty (kept — commit/merge first):');
        rep.dirty.forEach((w) => console.log(`${line(w)}${w.uncommitted ? ' [uncommitted]' : ''}${w.unmerged ? ' [unmerged]' : ''}`));
      }
      if (rep.missing?.length) { console.log('missing (directory gone, tombstoned):'); rep.missing.forEach((w) => console.log(line(w))); }
      if (rep.errors?.length) { console.log('errors:'); rep.errors.forEach((e) => console.log(`  ${e.branch ?? e.id}: ${e.error}`)); }
      if (!['removed', 'clean', 'dirty', 'missing', 'errors'].some((k) => rep[k]?.length)) console.log('nothing pending');
      break;
    }
    if (sub === 'rm') {
      const raw = process.argv[4];
      if (!raw || raw.startsWith('--')) { console.error('usage: sauron worktree rm <id|path> [--force]'); process.exit(1); }
      // path-looking refs resolve against the CLI's cwd, not the daemon's
      const ref = raw.includes('/') || raw.startsWith('.') ? resolve(raw) : raw;
      const r = await api('DELETE', `/api/worktree/${encodeURIComponent(ref)}`, { force: process.argv.includes('--force') });
      if (!r.ok) { console.error(r.error); process.exit(1); }
      console.log(`removed${r.note ? ` — ${r.note}` : ''}`);
      break;
    }
    console.log('usage: sauron worktree <ls|gc [--force]|rm <id|path> [--force]>');
    process.exit(sub ? 1 : 0);
    break;
  }
  case 'status': {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = await r.json();
      console.log(JSON.stringify(body));
      process.exit(body.ok ? 0 : 1);
    } catch {
      console.error(`sauron not running on 127.0.0.1:${port}`);
      process.exit(1);
    }
    break;
  }
  default:
    console.log(`usage: sauron <start|app|tui|spawn <repo> [--branch B] [--base B] [--preset P] [--via tmux|cmux] [--swarm N --prompt "task"] [--no-launch]|swarm <ls|adopt <id>>|worktree <ls|gc|rm>|install [--dry-run]|uninstall|status>`);
    process.exit(cmd ? 1 : 0);
}
