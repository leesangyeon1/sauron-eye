import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openStore } from '../core/store.js';
import { createRegistry } from '../core/registry.js';
import { startServer } from '../core/server.js';

const tmpDb = () => join(tmpdir(), `sauron-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
const cleanup = (p) => { for (const suf of ['', '-wal', '-shm']) rmSync(p + suf, { force: true }); };

const BEAT = {
  sessionId: 's1',
  ts: Date.now(),
  model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' },
  cost: { total_cost_usd: 1.23 },
  context: { used_pct: 42 },
  rate: {
    five_hour: { used_pct: 61, resets_at: '2026-07-12T09:00:00Z' },
    seven_day: { used_pct: 38, resets_at: '2026-07-15T00:00:00Z' },
  },
  cwd: '/tmp/proj',
  git_branch: 'dev',
};

test('registry state machine', (t) => {
  const db = tmpDb();
  t.after(() => cleanup(db));
  const store = openStore(db);
  t.after(() => store.close());
  const r = createRegistry(store);
  const st = () => r.sessions().find((s) => s.sessionId === 's1').state;

  r.ingestHook({ sessionId: 's1', event: 'session_start' });
  assert.equal(st(), 'working');
  r.ingestHook({ sessionId: 's1', event: 'stop' });
  assert.equal(st(), 'idle');
  r.ingestHook({ sessionId: 's1', event: 'user_prompt_submit' });
  assert.equal(st(), 'working');
  r.ingestHook({ sessionId: 's1', event: 'notification' });
  assert.equal(st(), 'needs_input');
  r.ingestHook({ sessionId: 's1', event: 'session_end' });
  assert.equal(st(), 'ended');

  // beat never resurrects an ended session
  r.ingestStatusline({ ...BEAT, ts: Date.now() });
  assert.equal(st(), 'ended');

  // brand-new beat creates a working session
  r.ingestStatusline({ ...BEAT, sessionId: 's2' });
  assert.equal(r.sessions().find((s) => s.sessionId === 's2').state, 'working');

  // lenient: garbage never throws
  r.ingestStatusline({});
  r.ingestStatusline(null);
  r.ingestHook({ sessionId: 's2', event: 'no_such_event' });
});

test('stale computation and sweep', (t) => {
  const db = tmpDb();
  t.after(() => cleanup(db));
  const store = openStore(db);
  t.after(() => store.close());
  const r = createRegistry(store);

  r.ingestStatusline({ sessionId: 'old', ts: Date.now() - 6 * 60_000 });
  assert.equal(r.sessions()[0].state, 'stale');

  const events = [];
  r.subscribe((e) => events.push(e));
  r.sweep();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session');
  assert.equal(events[0].data.state, 'stale');
  r.sweep(); // no duplicate emission
  assert.equal(events.length, 1);

  // ended sessions never go stale
  r.ingestHook({ sessionId: 'old', event: 'session_end', ts: Date.now() - 6 * 60_000 });
  assert.equal(r.sessions()[0].state, 'ended');
});

test('statusline field mapping + quota', (t) => {
  const db = tmpDb();
  t.after(() => cleanup(db));
  const store = openStore(db);
  t.after(() => store.close());
  const r = createRegistry(store);

  r.ingestStatusline(BEAT);
  const s = r.sessions()[0];
  assert.equal(s.model, 'Sonnet 5');
  assert.equal(s.modelId, 'claude-sonnet-5');
  assert.equal(s.costUsd, 1.23);
  assert.equal(s.contextPct, 42);
  assert.deepEqual(s.rate5h, { usedPct: 61, resetsAt: '2026-07-12T09:00:00Z' });
  assert.deepEqual(s.rate7d, { usedPct: 38, resetsAt: '2026-07-15T00:00:00Z' });
  assert.equal(s.cwd, '/tmp/proj');
  assert.equal(s.gitBranch, 'dev');

  // quota reflects the LATEST beat
  r.ingestStatusline({
    sessionId: 'later', ts: Date.now() + 1000,
    rate: { five_hour: { used_pct: 90, resets_at: 'x' } },
  });
  const q = r.quota();
  assert.equal(q.claude.rate5h.usedPct, 90);
});

test('store persists sessions across registries', (t) => {
  const db = tmpDb();
  t.after(() => cleanup(db));
  const store = openStore(db);
  createRegistry(store).ingestStatusline(BEAT);
  store.close();

  const store2 = openStore(db);
  t.after(() => store2.close());
  const r2 = createRegistry(store2);
  assert.equal(r2.sessions()[0].costUsd, 1.23);
});

test('http server smoke', async (t) => {
  const db = tmpDb();
  const srv = await startServer({ port: 0, dbPath: db });
  t.after(async () => { await srv.close(); cleanup(db); });
  const base = `http://127.0.0.1:${srv.port}`;

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);

  let r = await fetch(`${base}/ingest/statusline`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BEAT),
  });
  assert.equal((await r.json()).ok, true);

  const { sessions } = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 's1');
  assert.equal(sessions[0].state, 'working');
  assert.equal(sessions[0].model, 'Sonnet 5');

  await fetch(`${base}/ingest/hook`, {
    method: 'POST', body: JSON.stringify({ sessionId: 's1', event: 'stop' }),
  });
  const after = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(after.sessions[0].state, 'idle');

  const quota = await (await fetch(`${base}/api/quota`)).json();
  assert.equal(quota.providers.claude.rate5h.usedPct, 61);

  const miss = await fetch(`${base}/nope`);
  assert.equal(miss.status, 404);

  // path traversal: raw request (fetch would normalize ../ away)
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/../../etc/passwd' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});
