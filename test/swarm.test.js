import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs';
import { openStore } from '../core/store.js';
import { createRegistry } from '../core/registry.js';
import { createWorktreeManager } from '../core/worktree.js';
import { startServer } from '../core/server.js';

const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sauron-sw-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'hi');
  g(dir, 'add', '.');
  g(dir, 'commit', '-m', 'init');
  return realpathSync(dir);
}

function makeManager(t, { surface = null } = {}) {
  const db = join(tmpdir(), `sauron-sw-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-swroot-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const store = openStore(db);
  t.after(() => store.close());
  const registry = createRegistry(store);
  const mgr = createWorktreeManager(store, registry, { root, surface, fridgeUrl: 'http://127.0.0.1:1' });
  return { mgr, registry, store, root };
}

const commit = (wt, file, content, msg = 'work') => {
  writeFileSync(join(wt, file), content);
  g(wt, 'add', '.');
  g(wt, 'commit', '-m', msg);
};

test('swarm: N members, suffixed branches, shared swarmId + prompt, quota rides along', async (t) => {
  const repo = makeRepo(t);
  const calls = [];
  const stub = { launch: async (o) => { calls.push(o); return { ok: true, note: 'stub' }; } };
  const { mgr, registry } = makeManager(t, { surface: stub });
  registry.ingestStatusline({ sessionId: 'q1', rate: { five_hour: { used_pct: 80, resets_at: 'x' } } });

  const r = await mgr.swarm({ repoPath: repo, branch: 'try/refactor', count: 3, prompt: "rewrite the 'core' module" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.members.map((m) => m.branch), ['try/refactor-a', 'try/refactor-b', 'try/refactor-c']);
  assert.ok(r.members.every((m) => m.ok && m.swarmId === r.swarmId && existsSync(m.worktreePath)));
  assert.equal(r.quota.claude.rate5h.usedPct, 80); // spawn-time quota warning data
  // every member got the SAME prompt, shell-quoted into the launch command
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(c.command, `claude 'rewrite the '\\''core'\\'' module'`);

  // guards
  assert.equal((await mgr.swarm({ repoPath: repo, count: 1, prompt: 'x' })).ok, false);
  assert.equal((await mgr.swarm({ repoPath: repo, count: 3 })).ok, false); // prompt required

  const sw = mgr.swarms();
  assert.equal(sw.length, 1);
  assert.equal(sw[0].members.length, 3);
  assert.equal(sw[0].prompt, "rewrite the 'core' module");
});

test('diff: committed + uncommitted + untracked, all visible', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/d', launch: false });
  commit(r.worktreePath, 'a.txt', 'changed');           // committed
  writeFileSync(join(r.worktreePath, 'a.txt'), 'more'); // uncommitted on top
  writeFileSync(join(r.worktreePath, 'new.txt'), 'x');  // untracked

  const d = await mgr.diff(r.id);
  assert.equal(d.ok, true);
  assert.match(d.diff, /-hi/);
  assert.match(d.diff, /\+more/); // working tree wins — uncommitted included
  assert.match(d.stat, /a\.txt/);
  assert.deepEqual(d.untracked, ['new.txt']);
  assert.equal(d.truncated, false);
  assert.equal((await mgr.diff('nope')).ok, false);
});

test('adopt: merges winner into base, force-removes losers, keeps their branches', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const r = await mgr.swarm({ repoPath: repo, count: 3, prompt: 'task', branch: 'try/x', launch: false });
  const [a, b, c] = r.members;
  commit(a.worktreePath, 'win.txt', 'winner');
  commit(b.worktreePath, 'lose.txt', 'loser');
  writeFileSync(join(c.worktreePath, 'junk.txt'), 'dirty loser'); // uncommitted junk

  const ad = await mgr.adopt({ winnerId: a.id });
  assert.equal(ad.ok, true, ad.error);
  assert.equal(ad.merged, 'try/x-a');
  assert.equal(ad.into, 'main');
  assert.equal(readFileSync(join(repo, 'win.txt'), 'utf8'), 'winner'); // merge landed
  assert.equal(ad.losersRemoved.length, 2);
  assert.ok(!existsSync(b.worktreePath));
  assert.ok(!existsSync(c.worktreePath)); // dirty loser force-removed — explicitly discarded
  g(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/try/x-b'); // branches survive
  assert.equal(ad.branchCleanup.length, 2);

  // winner is now merged+clean → normal gc collects it
  const rep = await mgr.gc({ dryRun: false });
  assert.equal(rep.removed.length, 1);
  assert.ok(!existsSync(a.worktreePath));
});

test('adopt guards: dirty winner, wrong checkout, merge conflict', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const r = await mgr.swarm({ repoPath: repo, count: 2, prompt: 'task', branch: 'try/g', launch: false });
  const [a] = r.members;

  writeFileSync(join(a.worktreePath, 'wip.txt'), 'wip');
  assert.match((await mgr.adopt({ winnerId: a.id })).error, /uncommitted/);
  rmSync(join(a.worktreePath, 'wip.txt'));
  commit(a.worktreePath, 'a.txt', 'from-winner');

  g(repo, 'checkout', '-b', 'elsewhere');
  assert.match((await mgr.adopt({ winnerId: a.id })).error, /checkout main first/);
  g(repo, 'checkout', 'main');

  commit(repo, 'a.txt', 'conflicting-on-main');
  const conflict = await mgr.adopt({ winnerId: a.id });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /merge failed/);
  assert.equal(g(repo, 'status', '--porcelain'), ''); // aborted — repo left clean
  assert.equal((await mgr.adopt({ winnerId: 'nope' })).ok, false);
});

test('re-swarm on the same branch name refuses — discarded loser code must never resurrect', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const r1 = await mgr.swarm({ repoPath: repo, count: 2, prompt: 'X', branch: 'try/re', launch: false });
  commit(r1.members[0].worktreePath, 'w.txt', 'winner');
  commit(r1.members[1].worktreePath, 'loser.txt', 'discarded');
  assert.equal((await mgr.adopt({ winnerId: r1.members[0].id })).ok, true);

  // try/re-b branch still exists (kept by design) at its discarded tip
  const r2 = await mgr.swarm({ repoPath: repo, count: 2, prompt: 'Y', branch: 'try/re', launch: false });
  assert.equal(r2.ok, false);
  assert.ok(r2.members.some((m) => !m.ok && /already exists/.test(m.error)));
  // and nothing silently checked out the old loser branch
  for (const m of r2.members) if (m.ok) {
    assert.ok(!existsSync(join(m.worktreePath, 'loser.txt')), 'discarded code resurrected!');
  }

  // default-named swarms in the same second don't collide (random tail)
  const a = await mgr.swarm({ repoPath: repo, count: 2, prompt: 'p', launch: false });
  const b = await mgr.swarm({ repoPath: repo, count: 2, prompt: 'p', launch: false });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.members[0].branch, b.members[0].branch);
});

test('adopt skips losers whose session has not ENDED (stale may be a long tool call)', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  const r = await mgr.swarm({ repoPath: repo, count: 3, prompt: 'task', branch: 'try/live', launch: false });
  const [a, b, c] = r.members;
  commit(a.worktreePath, 'w.txt', 'w');
  registry.ingestHook({ sessionId: 'busy', event: 'session_start', cwd: b.worktreePath });
  writeFileSync(join(b.worktreePath, 'wip.txt'), 'uncommitted work in progress');

  const ad = await mgr.adopt({ winnerId: a.id });
  assert.equal(ad.ok, true, ad.error);
  assert.equal(ad.losersRemoved.length, 1); // only c (never linked)
  assert.equal(ad.losersSkipped.length, 1);
  assert.match(ad.losersSkipped[0].error, /session working/);
  assert.ok(existsSync(b.worktreePath)); // live session's dir untouched
  assert.ok(!existsSync(c.worktreePath));
});

test('diff stays scoped to the member after base moves (merge-base, not base tip)', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const r = await mgr.create({ repoPath: repo, branch: 'feat/mb', launch: false });
  commit(repo, 'main-moved.txt', 'after-branching'); // base advances after member branched

  const d = await mgr.diff(r.id);
  assert.equal(d.ok, true);
  assert.equal(d.diff, ''); // member changed nothing — base's new commit must NOT appear reversed
  commit(r.worktreePath, 'mine.txt', 'member work');
  const d2 = await mgr.diff(r.id);
  assert.match(d2.diff, /\+member work/);
  assert.ok(!/main-moved/.test(d2.diff));
});

test('adopt is re-runnable: alreadyMerged skips the merge, retries loser cleanup', async (t) => {
  const repo = makeRepo(t);
  const { mgr, registry } = makeManager(t);
  const r = await mgr.swarm({ repoPath: repo, count: 2, prompt: 'task', branch: 'try/rr', launch: false });
  const [a, b] = r.members;
  commit(a.worktreePath, 'w.txt', 'w');
  registry.ingestHook({ sessionId: 'hold', event: 'session_start', cwd: b.worktreePath });

  const first = await mgr.adopt({ winnerId: a.id });
  assert.equal(first.ok, true);
  assert.equal(first.alreadyMerged, false);
  assert.equal(first.losersSkipped.length, 1); // b held by live session

  registry.ingestHook({ sessionId: 'hold', event: 'session_end' });
  const second = await mgr.adopt({ winnerId: a.id });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyMerged, true); // no second merge commit
  assert.equal(second.losersRemoved.length, 1); // cleanup finally lands
  assert.equal(g(repo, 'rev-list', '--count', 'main'), '3'); // init + winner commit + ONE merge
});

test('adopt guards: worktree HEAD off-branch, unfinished merge in repo', async (t) => {
  const repo = makeRepo(t);
  const { mgr } = makeManager(t);
  const r = await mgr.swarm({ repoPath: repo, count: 2, prompt: 'task', branch: 'try/hd', launch: false });
  const [a] = r.members;
  commit(a.worktreePath, 'w.txt', 'w');

  g(a.worktreePath, 'checkout', '-b', 'side'); // agent wandered off the member branch
  assert.match((await mgr.adopt({ winnerId: a.id })).error, /instead of try\/hd-a/);
  g(a.worktreePath, 'checkout', 'try/hd-a');

  // unfinished merge sitting in the primary checkout → refuse before touching anything
  g(repo, 'checkout', '-b', 'tmp');
  commit(repo, 'tmp.txt', 't');
  g(repo, 'checkout', 'main');
  g(repo, 'merge', '--no-commit', '--no-ff', 'tmp');
  assert.match((await mgr.adopt({ winnerId: a.id })).error, /unfinished merge/);
  g(repo, 'merge', '--abort');
});

test('http swarm endpoints', async (t) => {
  const repo = makeRepo(t);
  const db = join(tmpdir(), `sauron-sw-http-${process.pid}.db`);
  const root = mkdtempSync(join(tmpdir(), 'sauron-swroot-'));
  const srv = await startServer({ port: 0, dbPath: db, worktreeRoot: root });
  t.after(async () => {
    await srv.close();
    rmSync(root, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (p, b) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });

  const sw = await (await post('/api/swarm/create', { repoPath: repo, count: 2, prompt: 'do it', branch: 'try/h', launch: false })).json();
  assert.equal(sw.ok, true);
  assert.equal(sw.members.length, 2);

  const ls = await (await fetch(`${base}/api/swarm/list`)).json();
  assert.equal(ls.swarms.length, 1);
  assert.equal(ls.swarms[0].prompt, 'do it');

  const winner = sw.members[0];
  const wt = winner.worktreePath;
  writeFileSync(join(wt, 'w.txt'), 'w');
  g(wt, 'add', '.');
  g(wt, 'commit', '-m', 'w');
  const d = await (await fetch(`${base}/api/worktree/diff?ref=${winner.id}`)).json();
  assert.equal(d.ok, true);
  assert.match(d.diff, /\+w/);
  assert.equal((await fetch(`${base}/api/worktree/diff?ref=zzz`)).status, 400);

  const ad = await (await post('/api/swarm/adopt', { winnerId: winner.id })).json();
  assert.equal(ad.ok, true, ad.error);
  assert.ok(existsSync(join(repo, 'w.txt')));
  assert.equal((await post('/api/swarm/adopt', { winnerId: 'zzz' })).status, 400);
});
