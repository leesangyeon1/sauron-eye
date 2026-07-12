import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { install, uninstall } from '../collectors/install.js';

function setup(settings) {
  const root = mkdtempSync(join(tmpdir(), 'sauron-install-'));
  const claude = join(root, 'claude');
  const home = join(root, 'sauron');
  mkdirSync(claude, { recursive: true });
  process.env.SAURON_CLAUDE_DIR = claude;
  process.env.SAURON_HOME = home;
  if (settings !== undefined) {
    writeFileSync(join(claude, 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  return { claude, home, settingsPath: join(claude, 'settings.json') };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const SEED = {
  statusLine: { type: 'command', command: '/usr/local/bin/my-status.sh' },
  hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo old-stop' }] }] },
};

test('install: backup, statusline takeover + chain, hook merge, idempotent', async () => {
  const { home, settingsPath } = setup(SEED);
  await install();

  assert.equal(readdirSync(join(home, 'backups')).length, 1, 'backup created');

  const s = readJson(settingsPath);
  assert.match(s.statusLine.command, /statusline\.js"?$/, 'statusLine is ours');
  assert.equal(readJson(join(home, 'config.json')).chainStatusline, '/usr/local/bin/my-status.sh');

  assert.equal(s.hooks.Stop.length, 2, 'existing Stop hook preserved, ours appended');
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo old-stop');
  assert.match(s.hooks.Stop[1].hooks[0].command, /hook\.js"? stop$/);
  for (const k of ['SessionStart', 'SessionEnd', 'Notification', 'UserPromptSubmit'])
    assert.equal(s.hooks[k].length, 1, `${k} hook installed`);

  await install(); // idempotent
  assert.deepEqual(readJson(settingsPath), s, 'second install changes nothing');
});

test('uninstall: restores original statusLine, strips our hooks only', async () => {
  const { settingsPath } = setup(SEED);
  await install();
  await uninstall();

  const s = readJson(settingsPath);
  assert.equal(s.statusLine.command, '/usr/local/bin/my-status.sh');
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'echo old-stop');
  for (const k of ['SessionStart', 'SessionEnd', 'Notification', 'UserPromptSubmit'])
    assert.equal(s.hooks[k], undefined, `${k} hooks removed`);
});

test('corrupted settings.json: install throws, writes nothing', async () => {
  const { home, settingsPath } = setup('{ this is not json');
  await assert.rejects(install(), /cannot parse/);
  assert.equal(readFileSync(settingsPath, 'utf8'), '{ this is not json', 'file untouched');
  assert.ok(!existsSync(join(home, 'backups')), 'no backup written');
  assert.ok(!existsSync(join(home, 'config.json')), 'no config written');
});
