import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { openStore } from '../core/store.js';
import { createRegistry } from '../core/registry.js';
import { createWorktreeManager, AGENT_NAMES } from '../core/worktree.js';
import { installAgents } from '../collectors/install-agents.js';

const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sauron-ag-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'hi');
  g(dir, 'add', '.'); g(dir, 'commit', '-m', 'init');
  return realpathSync(dir);
}

function makeManager(t, surface) {
  const db = join(tmpdir(), `sauron-ag-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-agroot-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true }); });
  const store = openStore(db);
  t.after(() => store.close());
  return createWorktreeManager(store, createRegistry(store), { root, surface, fridgeUrl: 'http://127.0.0.1:1' });
}

test('AGENT_NAMES exported', () => {
  assert.deepEqual(AGENT_NAMES, ['claude', 'codex', 'gemini', 'grok']);
});

test('spawn --agent launches the right CLI, stores it, rejects unknown', async (t) => {
  const repo = makeRepo(t);
  const calls = [];
  const mgr = makeManager(t, { launch: async (o) => { calls.push(o); return { ok: true, note: 'stub' }; } });

  const cases = {
    claude: /^claude 'do it'$/,
    codex: /^codex 'do it'$/,
    gemini: /^gemini -i 'do it'$/,
    grok: /^grok 'do it'$/,
  };
  for (const [agent, re] of Object.entries(cases)) {
    calls.length = 0;
    const r = await mgr.create({ repoPath: repo, branch: `a/${agent}`, agent, prompt: 'do it' });
    assert.equal(r.ok, true, `${agent} ok`);
    assert.equal(r.agent, agent);
    assert.match(calls[0].command, re, agent);
    assert.match(r.command, new RegExp(`&& ${cases[agent].source.replace(/^\^|\$$/g, '')}$`));
  }
  // no prompt → bare interactive command
  calls.length = 0;
  await mgr.create({ repoPath: repo, branch: 'a/bare', agent: 'gemini', launch: true });
  assert.equal(calls[0].command, 'gemini');

  assert.equal((await mgr.create({ repoPath: repo, branch: 'a/x', agent: 'cursor' })).ok, false);
  assert.match((await mgr.create({ repoPath: repo, branch: 'a/y', agent: 'nope' })).error, /unknown agent/);
});

test('agent persists across manager reload + shows in list', async (t) => {
  const repo = makeRepo(t);
  const db = join(tmpdir(), `sauron-agp-${process.pid}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-agroot-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true }); });
  let store = openStore(db);
  let mgr = createWorktreeManager(store, createRegistry(store), { root, fridgeUrl: 'http://127.0.0.1:1' });
  await mgr.create({ repoPath: repo, branch: 'a/persist', agent: 'codex', launch: false });
  store.close();

  store = openStore(db);
  t.after(() => store.close());
  mgr = createWorktreeManager(store, createRegistry(store), { root, fridgeUrl: 'http://127.0.0.1:1' });
  assert.equal(mgr.list()[0].agent, 'codex');
});

test('swarm carries the agent to every member', async (t) => {
  const repo = makeRepo(t);
  const calls = [];
  const mgr = makeManager(t, { launch: async (o) => { calls.push(o); return { ok: true }; } });
  const r = await mgr.swarm({ repoPath: repo, count: 3, prompt: 'task', branch: 'sw/g', agent: 'grok' });
  assert.equal(r.ok, true);
  assert.ok(r.members.every((m) => m.agent === 'grok'));
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(c.command, "grok 'task'");
});

// install-agents writes to a fake HOME — never the real ~/.gemini etc.
function fakeHome(t) {
  const h = mkdtempSync(join(tmpdir(), 'sauron-home-'));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  const saved = { home: process.env.SAURON_FAKE_HOME, sh: process.env.SAURON_HOME };
  process.env.SAURON_FAKE_HOME = h;
  process.env.SAURON_HOME = join(h, '.sauron');
  t.after(() => {
    if (saved.home === undefined) delete process.env.SAURON_FAKE_HOME; else process.env.SAURON_FAKE_HOME = saved.home;
    if (saved.sh === undefined) delete process.env.SAURON_HOME; else process.env.SAURON_HOME = saved.sh;
  });
  return h;
}

test('install-agents: skips CLIs with no config dir', async (t) => {
  fakeHome(t); // empty home → nothing set up
  const results = await installAgents();
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => !r.installed));
  assert.ok(results.every((r) => /not set up/.test(r.reason)));
});

test('install-agents gemini: merges hooks into settings.json, idempotent, preserves user keys', async (t) => {
  const h = fakeHome(t);
  mkdirSync(join(h, '.gemini'), { recursive: true });
  writeFileSync(join(h, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ matcher: '*', hooks: [{ name: 'mine', type: 'command', command: 'echo hi' }] }] } }));

  let res = (await installAgents()).find((r) => r.agent === 'gemini');
  assert.equal(res.installed, true);
  let s = JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(s.theme, 'dark'); // user key preserved
  assert.equal(s.hooks.SessionStart.length, 2); // user's + ours
  assert.ok(s.hooks.SessionStart.some((e) => e.hooks[0].command.includes('hook.js') && e.hooks[0].command.endsWith('gemini')));
  assert.ok(s.hooks.AfterTool[0].hooks[0].command.endsWith('gemini'));

  // idempotent — second run adds nothing
  await installAgents();
  s = JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(s.hooks.SessionStart.length, 2);
});

test('install-agents grok: writes hooks/sauron.json with claude-compatible events', async (t) => {
  const h = fakeHome(t);
  mkdirSync(join(h, '.grok'), { recursive: true });
  const res = (await installAgents()).find((r) => r.agent === 'grok');
  assert.equal(res.installed, true);
  const doc = JSON.parse(readFileSync(join(h, '.grok', 'hooks', 'sauron.json'), 'utf8'));
  assert.ok(doc.hooks.SessionStart[0].hooks[0].command.endsWith('grok'));
  assert.ok(doc.hooks.PostToolUse[0].hooks[0].command.includes('post_tool_use'));
});

test('install-agents codex: adds notify only when absent, never clobbers', async (t) => {
  const h = fakeHome(t);
  mkdirSync(join(h, '.codex'), { recursive: true });
  writeFileSync(join(h, '.codex', 'config.toml'), 'model = "o3"\n');
  let res = (await installAgents()).find((r) => r.agent === 'codex');
  assert.equal(res.installed, true);
  let toml = readFileSync(join(h, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "o3"/); // preserved
  assert.match(toml, /notify = \["node", ".*codex-notify\.js"\]/);

  // existing notify → refuse
  res = (await installAgents()).find((r) => r.agent === 'codex');
  assert.equal(res.installed, false);
  assert.match(res.reason, /already has a `notify`/);
});
