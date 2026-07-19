import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { openStore } from '../core/store.js';
import { createRegistry } from '../core/registry.js';
import { createWorktreeManager } from '../core/worktree.js';
import { startServer } from '../core/server.js';
import * as tmux from '../surfaces/tmux.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../bin/sauron.js');
const execP = promisify(execFile);
const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

function initRepo(dir) {
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'hi');
  g(dir, 'add', '.');
  g(dir, 'commit', '-m', 'init');
  return realpathSync(dir);
}

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sauron-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return initRepo(dir);
}

// fridgeUrl on a closed port: preset path fails fast, no AI-Refrigerator needed for tests
function makeManager(t, { surface = null } = {}) {
  const db = join(tmpdir(), `sauron-wt-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-wtroot-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const store = openStore(db);
  t.after(() => store.close());
  const registry = createRegistry(store);
  const mgr = createWorktreeManager(store, registry, { root, surface, fridgeUrl: 'http://127.0.0.1:1' });
  return { mgr, registry, store, root, db };
}

test('create: worktree + branch + provisioning row', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);

  const r = await mgr.create({ repoPath: repo, branch: 'feat/x', launch: false });
  assert.equal(r.ok, true);
  assert.equal(r.reused, false);
  assert.equal(r.branch, 'feat/x');
  assert.equal(r.baseBranch, 'main');
  assert.ok(existsSync(r.worktreePath));
  assert.ok(r.worktreePath.endsWith('feat-x')); // branch slug: lowercase, non-alnum runs → -
  assert.ok(g(repo, 'worktree', 'list').includes(r.worktreePath));
  assert.match(r.command, /^cd '.*' && claude$/);
  assert.equal(mgr.list()[0].status, 'provisioning');

  // default branch naming
  const r2 = await mgr.create({ repoPath: repo, launch: false });
  assert.equal(r2.ok, true);
  assert.match(r2.branch, /^sauron\/.+-\d{8}-\d{6}$/);
});

test('create is idempotent for the same branch', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const a = await mgr.create({ repoPath: repo, branch: 'feat/x', launch: false });
  const b = await mgr.create({ repoPath: repo, branch: 'feat/x', launch: false });
  assert.equal(b.ok, true);
  assert.equal(b.reused, true);
  assert.equal(b.worktreePath, a.worktreePath);
  assert.equal(mgr.list().length, 1);
});

test('slug rule: lossy slug documented, distinct branches never collide', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const a = await mgr.create({ repoPath: repo, branch: 'Feat/x_1', launch: false });
  assert.ok(a.worktreePath.endsWith('feat-x-1'));

  // feat/x vs feat_x slug identically — must yield SEPARATE worktrees on the right branches
  const b = await mgr.create({ repoPath: repo, branch: 'feat/x', launch: false });
  const c = await mgr.create({ repoPath: repo, branch: 'feat_x', launch: false });
  assert.equal(c.ok, true);
  assert.equal(c.reused, false);
  assert.notEqual(c.worktreePath, b.worktreePath);
  assert.equal(g(c.worktreePath, 'branch', '--show-current'), 'feat_x');
  assert.equal(g(b.worktreePath, 'branch', '--show-current'), 'feat/x');
});

test('same-basename repos never share a worktree', async (t) => {
  const parent1 = mkdtempSync(join(tmpdir(), 'sauron-p1-'));
  const parent2 = mkdtempSync(join(tmpdir(), 'sauron-p2-'));
  t.after(() => { rmSync(parent1, { recursive: true, force: true }); rmSync(parent2, { recursive: true, force: true }); });
  mkdirSync(join(parent1, 'api')); mkdirSync(join(parent2, 'api'));
  const repoA = initRepo(join(parent1, 'api'));
  const repoB = initRepo(join(parent2, 'api'));
  const { mgr } = makeManager(t);

  const a = await mgr.create({ repoPath: repoA, branch: 'feat/x', launch: false });
  const b = await mgr.create({ repoPath: repoB, branch: 'feat/x', launch: false });
  assert.equal(b.ok, true);
  assert.equal(b.reused, false); // NOT the other repo's worktree
  assert.notEqual(b.worktreePath, a.worktreePath);
  assert.equal(a.repoPath, repoA);
  assert.equal(b.repoPath, repoB);
});

test('create rejects non-repos and missing repoPath', async (t) => {
  const { mgr } = makeManager(t);
  const dir = mkdtempSync(join(tmpdir(), 'sauron-norepo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await mgr.create({ repoPath: dir, launch: false })).ok, false);
  assert.equal((await mgr.create({})).ok, false);
  assert.equal(mgr.list().length, 0);
});

test('session link by cwd: provisioning → active → pending-cleanup → active (resume)', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/link', launch: false });

  registry.ingestHook({ sessionId: 'sess1', event: 'session_start', cwd: r.worktreePath });
  let w = mgr.list()[0];
  assert.equal(w.status, 'active');
  assert.equal(w.sessionId, 'sess1');
  assert.equal(w.session.state, 'working');

  registry.ingestHook({ sessionId: 'sess1', event: 'session_end' });
  w = mgr.list()[0];
  assert.equal(w.status, 'pending-cleanup');
  assert.ok(w.endedAt);

  // resume: SessionStart again in the same cwd re-activates
  registry.ingestHook({ sessionId: 'sess1', event: 'session_start', cwd: r.worktreePath });
  w = mgr.list()[0];
  assert.equal(w.status, 'active');
  assert.equal(w.endedAt, null);
});

test('gc: dirty is never deleted, clean is removed only with dryRun=false', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/gc', launch: false });
  registry.ingestHook({ sessionId: 'gc1', event: 'session_start', cwd: r.worktreePath });
  registry.ingestHook({ sessionId: 'gc1', event: 'session_end' });

  // uncommitted file → dirty, directory survives even without dryRun
  writeFileSync(join(r.worktreePath, 'wip.txt'), 'wip');
  let rep = await mgr.gc({ dryRun: false });
  assert.equal(rep.dirty.length, 1);
  assert.equal(rep.dirty[0].uncommitted, true);
  assert.equal(rep.removed.length, 0);
  assert.ok(existsSync(r.worktreePath));

  // committed but unmerged → still dirty
  g(r.worktreePath, 'add', '.');
  g(r.worktreePath, 'commit', '-m', 'wip');
  rep = await mgr.gc({ dryRun: false });
  assert.equal(rep.dirty.length, 1);
  assert.equal(rep.dirty[0].unmerged, true);
  assert.ok(existsSync(r.worktreePath));

  // merged → clean; dryRun reports without deleting
  g(repo, 'merge', 'feat/gc');
  rep = await mgr.gc({ dryRun: true });
  assert.equal(rep.clean.length, 1);
  assert.ok(existsSync(r.worktreePath));

  // dryRun=false → removed, branch deleted, worktree gone
  rep = await mgr.gc({ dryRun: false });
  assert.equal(rep.removed.length, 1);
  assert.ok(!existsSync(r.worktreePath));
  assert.ok(!g(repo, 'worktree', 'list').includes(r.worktreePath));
  assert.throws(() => g(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/gc'));
  assert.equal(mgr.list().length, 0);
});

test('gc ignores active sessions', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/live', launch: false });
  registry.ingestHook({ sessionId: 'live1', event: 'session_start', cwd: r.worktreePath });
  const rep = await mgr.gc({ dryRun: false });
  assert.equal(rep.clean.length + rep.dirty.length + rep.removed.length, 0);
  assert.ok(existsSync(r.worktreePath));
});

test('gc unsticks active rows whose session died without session_end', async (t) => {
  const repo = makeRepo(t);
  const db = join(tmpdir(), `sauron-wt-orphan-${process.pid}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-wtroot-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const store = openStore(db);
  const registry = createRegistry(store);
  const mgr = createWorktreeManager(store, registry, { root, fridgeUrl: 'http://127.0.0.1:1' });
  const r = await mgr.create({ repoPath: repo, branch: 'feat/orphan', launch: false });
  registry.ingestHook({ sessionId: 'dead1', event: 'session_start', cwd: r.worktreePath });
  assert.equal(mgr.list()[0].status, 'active');
  store.close();

  // simulate reboot: session comes back 6min stale (SIGKILL — no session_end ever arrived)
  const store2 = openStore(db);
  t.after(() => store2.close());
  const sess = store2.loadSessions().find((s) => s.sessionId === 'dead1');
  sess.lastSeen = Date.now() - 6 * 60_000;
  store2.saveSession(sess);
  const registry2 = createRegistry(store2);
  const mgr2 = createWorktreeManager(store2, registry2, { root, fridgeUrl: 'http://127.0.0.1:1' });
  assert.equal(mgr2.list()[0].status, 'active'); // still stuck...
  const rep = await mgr2.gc({ dryRun: true });
  assert.equal(rep.clean.length, 1); // ...until gc demotes and processes it
  // and remove() is no longer deadlocked either
  const rm = await mgr2.remove(rep.clean[0].id);
  assert.equal(rm.ok, true);
});

test('gc reports merged-check errors instead of misclassifying as dirty', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  g(repo, 'branch', 'base2');
  const r = await mgr.create({ repoPath: repo, branch: 'feat/eb', baseBranch: 'base2', launch: false });
  registry.ingestHook({ sessionId: 'eb1', event: 'session_start', cwd: r.worktreePath });
  registry.ingestHook({ sessionId: 'eb1', event: 'session_end' });
  g(repo, 'branch', '-D', 'base2'); // base vanished → merged-check must error, not report "unmerged"
  const rep = await mgr.gc({ dryRun: true });
  assert.equal(rep.dirty.length, 0);
  assert.equal(rep.errors.length, 1);
  assert.match(rep.errors[0].error, /base "base2" missing/);
});

test('gc prunes vanished dirs so the same branch can respawn', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/pr', launch: false });
  registry.ingestHook({ sessionId: 'pr1', event: 'session_start', cwd: r.worktreePath });
  registry.ingestHook({ sessionId: 'pr1', event: 'session_end' });
  rmSync(r.worktreePath, { recursive: true, force: true }); // user rm -rf'd it manually
  const rep = await mgr.gc({ dryRun: true });
  assert.equal(rep.missing.length, 1);
  // without `git worktree prune` this fails: "'feat/pr' is already used by worktree at ..."
  const again = await mgr.create({ repoPath: repo, branch: 'feat/pr', launch: false });
  assert.equal(again.ok, true);
  assert.ok(existsSync(again.worktreePath));
});

test('remove: dirty refuses without force, force keeps the branch', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/rm', launch: false });
  writeFileSync(join(r.worktreePath, 'wip.txt'), 'wip');

  const refuse = await mgr.remove(r.id);
  assert.equal(refuse.ok, false);
  assert.match(refuse.error, /dirty/);
  assert.ok(existsSync(r.worktreePath));

  const forced = await mgr.remove(r.id, { force: true });
  assert.equal(forced.ok, true);
  assert.ok(!existsSync(r.worktreePath));
  // branch survives: -D is banned, unmerged -d would fail
  g(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/rm');

  assert.equal((await mgr.remove('nope')).ok, false);
});

test('remove refuses active worktrees, accepts path refs', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/act', launch: false });
  registry.ingestHook({ sessionId: 'act1', event: 'session_start', cwd: r.worktreePath });
  const refuse = await mgr.remove(r.worktreePath);
  assert.equal(refuse.ok, false);
  assert.match(refuse.error, /active/);
});

test('preset failure is a warning, not an error', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t); // fridgeUrl → closed port
  const r = await mgr.create({ repoPath: repo, branch: 'feat/preset', presetId: 'frontend', launch: false });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /skipped|failed/);
});

test('preset success: fridge called with mode=project + worktree path, no warnings', async (t) => {
  const repo = makeRepo(t);
  const captured = [];
  const fridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/apply') captured.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { written: [] } }));
    });
  });
  await new Promise((r2) => fridge.listen(0, '127.0.0.1', r2));
  t.after(() => new Promise((r2) => fridge.close(r2)));

  const db = join(tmpdir(), `sauron-wt-fr-${process.pid}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-wtroot-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const store = openStore(db);
  t.after(() => store.close());
  const mgr = createWorktreeManager(store, createRegistry(store), {
    root, fridgeUrl: `http://127.0.0.1:${fridge.address().port}`,
  });
  const r = await mgr.create({ repoPath: repo, branch: 'feat/fr', presetId: 'backend-api', launch: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], { presetId: 'backend-api', mode: 'project', projectPath: r.worktreePath, dryRun: false });
});

test('surface: launch result propagates, failure falls back to command', async (t) => {
  const repo = makeRepo(t);
  const calls = [];
  const stub = {
    detect: async () => ({ available: true }),
    launch: async (opts) => { calls.push(opts); return { ok: true, note: 'stub pane' }; },
  };
  const { mgr } = makeManager(t, { surface: stub });
  const r = await mgr.create({ repoPath: repo, branch: 'feat/surf' });
  assert.equal(r.surface.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, r.worktreePath);
  assert.equal(calls[0].command, 'claude');

  const { mgr: mgr2 } = makeManager(t, { surface: { launch: async () => ({ ok: false, hint: 'no tmux' }) } });
  const r2 = await mgr2.create({ repoPath: repo, branch: 'feat/surf2' });
  assert.equal(r2.surface.ok, false);
  assert.match(r2.command, /claude/); // fallback command always present
});

test('boot reconcile: vanished directory → removed tombstone', async (t) => {
  const repo = makeRepo(t);
  const db = join(tmpdir(), `sauron-wt-rec-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-wtroot-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const store = openStore(db);
  const registry = createRegistry(store);
  const mgr = createWorktreeManager(store, registry, { root, fridgeUrl: 'http://127.0.0.1:1' });
  const r = await mgr.create({ repoPath: repo, branch: 'feat/rec', launch: false });
  store.close();

  g(repo, 'worktree', 'remove', '--force', r.worktreePath); // user removed it manually

  const store2 = openStore(db);
  t.after(() => store2.close());
  const mgr2 = createWorktreeManager(store2, createRegistry(store2), { root, fridgeUrl: 'http://127.0.0.1:1' });
  assert.equal(mgr2.list().length, 0); // tombstoned on boot
});

test('http worktree endpoints', async (t) => {
  const repo = makeRepo(t);
  const db = join(tmpdir(), `sauron-wt-http-${process.pid}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-wtroot-'));
  const srv = await startServer({ port: 0, dbPath: db, worktreeRoot: root });
  t.after(async () => {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  let r = await (await post('/api/worktree/create', { repoPath: repo, branch: 'feat/http', launch: false })).json();
  assert.equal(r.ok, true);
  assert.ok(existsSync(r.worktreePath));

  const bad = await post('/api/worktree/create', { repoPath: '/nope', launch: false });
  assert.equal(bad.status, 400);

  const { worktrees } = await (await fetch(`${base}/api/worktree/list`)).json();
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].branch, 'feat/http');

  const rep = await (await post('/api/worktree/gc', { dryRun: true })).json();
  assert.ok(Array.isArray(rep.clean)); // provisioning rows untouched by gc
  assert.equal(rep.clean.length + rep.dirty.length + rep.removed.length, 0);

  const del = await fetch(`${base}/api/worktree/${r.id}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: false }),
  });
  const delBody = await del.json();
  assert.equal(delBody.ok, true); // fresh worktree is clean → removable without force
  assert.ok(!existsSync(r.worktreePath));
});

test('a second session cannot steal the link from a live one', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/steal', launch: false });
  registry.ingestHook({ sessionId: 'first', event: 'session_start', cwd: r.worktreePath });
  registry.ingestHook({ sessionId: 'second', event: 'session_start', cwd: r.worktreePath });
  assert.equal(mgr.list()[0].sessionId, 'first'); // first live session keeps the worktree
  // but once the first ends, the second's next activity takes over
  registry.ingestHook({ sessionId: 'first', event: 'session_end' });
  registry.ingestHook({ sessionId: 'second', event: 'user_prompt_submit', cwd: r.worktreePath });
  assert.equal(mgr.list()[0].sessionId, 'second');
  assert.equal(mgr.list()[0].status, 'active');
});

test('SSE replays worktree snapshot on connect', async (t) => {
  const repo = makeRepo(t);
  const db = join(tmpdir(), `sauron-wt-sse-${process.pid}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-wtroot-'));
  const srv = await startServer({ port: 0, dbPath: db, worktreeRoot: root });
  t.after(async () => {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const created = await (await fetch(`${base}/api/worktree/create`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath: repo, branch: 'feat/sse', launch: false }),
  })).json();
  assert.equal(created.ok, true);

  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  let buf = '';
  while (!buf.includes('event: worktree')) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  ac.abort();
  const line = buf.split('\n').find((l, i, a) => a[i - 1] === 'event: worktree' && l.startsWith('data: '));
  const wt = JSON.parse(line.slice(6));
  assert.equal(wt.branch, 'feat/sse');
  assert.equal(wt.status, 'provisioning');
});

test('surfaces/tmux: detect shape + missing-binary degradation', async (t) => {
  const det = await tmux.detect();
  assert.equal(typeof det.available, 'boolean');
  if (det.available) assert.match(det.version, /tmux/);

  const savedPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  t.after(() => { process.env.PATH = savedPath; });
  const r = await tmux.launch({ cwd: tmpdir(), command: 'claude' });
  assert.equal(r.ok, false); // contract: degrade, never throw
  assert.ok(r.hint);
  assert.deepEqual(await tmux.detect(), { available: false });
});

test('CLI: spawn/ls/gc/rm end-to-end through bin/sauron.js', async (t) => {
  const repo = makeRepo(t);
  const db = join(tmpdir(), `sauron-wt-cli-${process.pid}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-wtroot-'));
  const srv = await startServer({ port: 0, dbPath: db, worktreeRoot: root });
  t.after(async () => {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const env = { ...process.env, SAURON_PORT: String(srv.port) };
  delete env.TMUX_PANE; // deterministic: no split attempt
  // async — execFileSync would block the event loop the test server runs on (deadlock)
  const cli = async (...args) => (await execP(process.execPath, [BIN, ...args], { encoding: 'utf8', env })).stdout;

  const out = await cli('spawn', repo, '--branch', 'feat/cli', '--no-launch');
  assert.match(out, /worktree: /);
  assert.match(out, /branch: {3}feat\/cli \(base main\)/);
  const wtPath = out.match(/worktree: (\S+)/)[1];
  assert.ok(existsSync(wtPath));

  assert.match(await cli('worktree', 'ls'), /feat\/cli/);
  assert.match(await cli('worktree', 'gc'), /nothing pending/); // provisioning rows untouched
  assert.match(await cli('worktree', 'rm', wtPath), /removed/); // clean → no force needed
  assert.ok(!existsSync(wtPath));
  assert.match(await cli('worktree', 'ls'), /no worktrees/);

  // --via validation is client-side
  await assert.rejects(cli('spawn', repo, '--via', 'kitty'), /unknown surface/);
});
