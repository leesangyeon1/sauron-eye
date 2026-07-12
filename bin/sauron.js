#!/usr/bin/env node
const cmd = process.argv[2];
const port = Number(process.env.SAURON_PORT) || 4870;

const missing = (what) => {
  console.error(`${what} is not built yet in this checkout.`);
  process.exit(1);
};

switch (cmd) {
  case 'start': {
    const { startServer } = await import('../core/server.js');
    const srv = await startServer();
    console.log(`sauron eye open: http://127.0.0.1:${srv.port}`);
    break; // foreground: server keeps the event loop alive
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
    console.log(`usage: sauron <start|tui|install [--dry-run]|uninstall|status>`);
    process.exit(cmd ? 1 : 0);
}
