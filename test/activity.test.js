import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openStore } from '../core/store.js';
import { createRegistry } from '../core/registry.js';
import { startServer } from '../core/server.js';

const tmpDb = () => join(tmpdir(), `sauron-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
const cleanup = (p) => { for (const suf of ['', '-wal', '-shm']) rmSync(p + suf, { force: true }); };

function freshRegistry(t) {
  const db = tmpDb();
  t.after(() => cleanup(db));
  const store = openStore(db);
  t.after(() => store.close());
  return { store, r: createRegistry(store) };
}

const hook = (r, event, meta, ts, sessionId = 's1') => r.ingestHook({ sessionId, event, ts, meta });
const act = (r, id = 's1') => r.sessions().find((s) => s.sessionId === id).activity;

test('pre_tool_use opens, post_tool_use closes with ms', (t) => {
  const { r } = freshRegistry(t);

  hook(r, 'pre_tool_use', { tool_name: 'Bash', tool_use_id: 'tu1' }, 5000);
  let a = act(r);
  assert.equal(a.openTools.length, 1);
  assert.deepEqual(a.openTools[0], { name: 'Bash', server: null, tool_use_id: 'tu1', startedAt: 5000 });

  hook(r, 'post_tool_use', { tool_name: 'Bash', tool_use_id: 'tu1' }, 5812);
  a = act(r);
  assert.equal(a.openTools.length, 0);
  assert.equal(a.recentTools.length, 1);
  assert.deepEqual(a.recentTools[0], { name: 'Bash', server: null, ms: 812, endedAt: 5812 });

  // no tool_use_id → same-name FIFO close (parallel calls complete in issue order)
  hook(r, 'pre_tool_use', { tool_name: 'Read' }, 6000);
  hook(r, 'pre_tool_use', { tool_name: 'Read' }, 6100);
  hook(r, 'post_tool_use', { tool_name: 'Read' }, 6200);
  a = act(r);
  assert.equal(a.openTools.length, 1);
  assert.equal(a.openTools[0].startedAt, 6100); // oldest was closed, newest stays open
  assert.equal(a.recentTools[0].ms, 200);
});

test('Skill increments skill counts', (t) => {
  const { r } = freshRegistry(t);
  hook(r, 'pre_tool_use', { tool_name: 'Skill', tool_input: { skill: 'deep-research' } }, 1000);
  hook(r, 'pre_tool_use', { tool_name: 'Skill', tool_input: { skill: 'deep-research' } }, 2000);
  hook(r, 'pre_tool_use', { tool_name: 'Skill', tool_input: { command: 'caveman' } }, 3000);
  const a = act(r);
  assert.deepEqual(a.skills, [
    { name: 'deep-research', count: 2, lastUsed: 2000 },
    { name: 'caveman', count: 1, lastUsed: 3000 },
  ]);
});

test('Task + subagent_stop agent lifecycle', (t) => {
  const { r } = freshRegistry(t);
  hook(r, 'pre_tool_use', { tool_name: 'Task', tool_input: { subagent_type: 'Explore' } }, 1000);
  hook(r, 'pre_tool_use', { tool_name: 'Task', tool_input: { subagent_type: 'Builder' } }, 2000);
  let a = act(r);
  assert.deepEqual(a.agents, [
    { type: 'Explore', startedAt: 1000, endedAt: null },
    { type: 'Builder', startedAt: 2000, endedAt: null },
  ]);

  hook(r, 'subagent_stop', {}, 3000);
  a = act(r);
  assert.equal(a.agents[1].endedAt, 3000); // newest open agent closed first
  assert.equal(a.agents[0].endedAt, null);
  hook(r, 'subagent_stop', {}, 4000);
  assert.equal(act(r).agents[0].endedAt, 4000);
  // nothing open: no-op, no throw
  hook(r, 'subagent_stop', {}, 5000);
});

test('mcp__github__search → server + mcpServers set', (t) => {
  const { r } = freshRegistry(t);
  hook(r, 'pre_tool_use', { tool_name: 'mcp__github__search', tool_use_id: 'g1' }, 1000);
  let a = act(r);
  assert.equal(a.openTools[0].server, 'github');
  assert.deepEqual(a.mcpServers, ['github']);
  hook(r, 'pre_tool_use', { tool_name: 'mcp__github__get_issue' }, 1100);
  assert.deepEqual(act(r).mcpServers, ['github']); // unique
  hook(r, 'post_tool_use', { tool_use_id: 'g1' }, 1500);
  a = act(r);
  assert.equal(a.recentTools[0].server, 'github');
  assert.equal(a.recentTools[0].ms, 500);
});

test('unknown/prototype event names are ignored', (t) => {
  const { r } = freshRegistry(t);
  const now = Date.now();
  hook(r, 'session_start', undefined, now);
  for (const ev of ['no_such_event', 'constructor', 'hasOwnProperty', 'toString']) {
    hook(r, ev, { tool_name: 'Bash' }, now + 1000);
  }
  const s = r.sessions()[0];
  assert.equal(s.state, 'working');
  assert.equal(s.activity, undefined); // no activity created by non-activity events
});

test('recentTools cap 20, openTools cap 10 overflow', (t) => {
  const { r } = freshRegistry(t);
  for (let i = 0; i < 25; i++) {
    hook(r, 'pre_tool_use', { tool_name: 'Bash', tool_use_id: `t${i}` }, 1000 + i);
    hook(r, 'post_tool_use', { tool_use_id: `t${i}` }, 2000 + i);
  }
  let a = act(r);
  assert.equal(a.recentTools.length, 20);
  assert.equal(a.recentTools[0].endedAt, 2024); // newest first

  // openTools overflow: oldest auto-moved to recentTools without ms
  for (let i = 0; i < 12; i++) hook(r, 'pre_tool_use', { tool_name: 'Read', tool_use_id: `o${i}` }, 3000 + i);
  a = act(r);
  assert.equal(a.openTools.length, 10);
  assert.equal(a.openTools[0].tool_use_id, 'o2');
  assert.equal(a.recentTools[0].ms, null);
});

test('groups: aggregation, sessionless installed provider, sorting', (t) => {
  const { r } = freshRegistry(t);
  r.ingestStatusline({ sessionId: 'c1', ts: 1000, cost: { total_cost_usd: 1 }, rate: { five_hour: { used_pct: 60, resets_at: 'a' } } });
  r.ingestStatusline({ sessionId: 'c2', ts: 2000, cost: { total_cost_usd: 2 }, rate: { five_hour: { used_pct: 70, resets_at: 'b' } } });
  r.ingestStatusline({ sessionId: 'x1', ts: 1500, provider: 'codex' });

  const groups = r.groups({
    providers: [
      { provider: 'claude', label: 'Claude Code', detect: { installed: true } },
      { provider: 'gemini', label: 'Gemini CLI', detect: { installed: true, version: '2.0', plan: 'pro' } },
      { provider: 'cursor', label: 'Cursor', detect: { installed: false } }, // uninstalled + sessionless → dropped
    ],
  });
  assert.deepEqual(groups.map((g) => g.provider), ['claude', 'codex', 'gemini']); // session count desc

  const claude = groups[0];
  assert.equal(claude.label, 'Claude Code');
  assert.equal(claude.installed, true);
  assert.equal(claude.usage.rate5h.usedPct, 70); // latest beat wins
  assert.equal(claude.usage.costUsd, 3); // summed
  assert.equal(claude.sessions.length, 2);
  assert.equal(claude.sessions[0].sessionId, 'c2'); // lastSeen desc

  const codex = groups[1];
  assert.equal(codex.installed, true); // has a session even without detect
  assert.equal(codex.sessions[0].provider, 'codex');

  const gemini = groups[2];
  assert.deepEqual(gemini.sessions, []);
  assert.equal(gemini.version, '2.0');
  assert.equal(gemini.plan, 'pro');
});

test('kv roundtrip', (t) => {
  const db = tmpDb();
  t.after(() => cleanup(db));
  const store = openStore(db);
  t.after(() => store.close());
  assert.equal(store.kvGet('missing'), null);
  store.kvSet('map', { nodes: [{ id: 'n1' }], edges: [] });
  assert.deepEqual(store.kvGet('map'), { nodes: [{ id: 'n1' }], edges: [] });
  store.kvSet('map', { nodes: [], edges: [] }); // overwrite
  assert.deepEqual(store.kvGet('map'), { nodes: [], edges: [] });
});

test('map PUT/GET + catalog + export over HTTP', async (t) => {
  const db = tmpDb();
  const srv = await startServer({ port: 0, dbPath: db });
  t.after(async () => { await srv.close(); cleanup(db); });
  const base = `http://127.0.0.1:${srv.port}`;

  // empty default
  assert.deepEqual(await (await fetch(`${base}/api/map`)).json(), { nodes: [], edges: [] });

  // invalid doc rejected
  const bad = await fetch(`${base}/api/map`, { method: 'PUT', body: JSON.stringify({ nodes: 'nope' }) });
  assert.equal(bad.status, 400);

  const doc = {
    nodes: [
      { id: 'n1', type: 'provider', x: 0, y: 0, label: 'Claude', meta: {} },
      { id: 'n2', type: 'mcp', x: 100, y: 0, label: 'GitHub', meta: { catalogId: 'github' } },
      { id: 'n3', type: 'mcp', x: 200, y: 0, label: 'Mystery', meta: { catalogId: 'nonexistent' } },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', kind: 'mcp' }],
  };
  const put = await fetch(`${base}/api/map`, { method: 'PUT', body: JSON.stringify(doc) });
  assert.equal((await put.json()).ok, true);
  assert.deepEqual(await (await fetch(`${base}/api/map`)).json(), doc);

  const { catalog } = await (await fetch(`${base}/api/mcp/catalog`)).json();
  assert.ok(catalog.find((c) => c.id === 'github'));

  const exported = await (await fetch(`${base}/api/map/export`)).json();
  assert.equal(exported.mcpServers.github.command, 'npx');
  assert.equal(exported.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN, '<GITHUB_TOKEN>');
  assert.equal(Object.keys(exported.mcpServers).length, 1); // unknown catalogId skipped
});

test('GET /api/groups over HTTP carries provider + activity', async (t) => {
  const db = tmpDb();
  const srv = await startServer({ port: 0, dbPath: db });
  t.after(async () => { await srv.close(); cleanup(db); });
  const base = `http://127.0.0.1:${srv.port}`;

  await fetch(`${base}/ingest/hook`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 's1', event: 'pre_tool_use', ts: 1000, meta: { tool_name: 'mcp__github__search' } }),
  });
  const { groups } = await (await fetch(`${base}/api/groups`)).json();
  const claude = groups.find((g) => g.provider === 'claude');
  assert.ok(claude);
  assert.equal(claude.sessions[0].provider, 'claude');
  assert.deepEqual(claude.sessions[0].activity.mcpServers, ['github']);
});
