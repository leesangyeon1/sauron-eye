#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cmd = process.argv[2];
const port = Number(process.env.SAURON_PORT) || 4870;

const missing = (what) => {
  console.error(`${what} is not built yet in this checkout.`);
  process.exit(1);
};

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
    console.log(`usage: sauron <start|app|tui|install [--dry-run]|uninstall|status>`);
    process.exit(cmd ? 1 : 0);
}
