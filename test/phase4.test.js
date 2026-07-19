import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openStore } from '../core/store.js';
import { createRegistry } from '../core/registry.js';
import { createNotifier } from '../core/notifier.js';
import * as cmux from '../surfaces/cmux.js';
import { surfaceFor, launch as autoLaunch } from '../surfaces/auto.js';

const tmpDb = () => join(tmpdir(), `sauron-p4-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

function makeRegistry(t) {
  const db = tmpDb();
  t.after(() => { for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true }); });
  const store = openStore(db);
  t.after(() => store.close());
  return createRegistry(store);
}

test('notifier: fires once on entering needs_input, resets after leaving', (t) => {
  const r = makeRegistry(t);
  const calls = [];
  const stop = createNotifier(r, { platform: 'darwin', exec: (...a) => calls.push(a) });
  t.after(stop);

  r.ingestHook({ sessionId: 'n1', event: 'session_start', cwd: '/tmp/projx' });
  assert.equal(calls.length, 0);
  r.ingestHook({ sessionId: 'n1', event: 'notification' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
  assert.match(calls[0][1][1], /waiting for input/);
  assert.match(calls[0][1][1], /projx/);

  // repeated needs_input events (multiple permission prompts queued) → no spam
  r.ingestHook({ sessionId: 'n1', event: 'notification' });
  assert.equal(calls.length, 1);

  // answered (working) then waiting again → notify again
  r.ingestHook({ sessionId: 'n1', event: 'user_prompt_submit' });
  r.ingestHook({ sessionId: 'n1', event: 'notification' });
  assert.equal(calls.length, 2);
});

test('notifier: body is sanitized — no quote smuggling into osascript', (t) => {
  const r = makeRegistry(t);
  const calls = [];
  const stop = createNotifier(r, { platform: 'darwin', exec: (...a) => calls.push(a) });
  t.after(stop);
  r.ingestHook({ sessionId: 'evil', event: 'notification', cwd: '/tmp/a"b\\c$(rm -rf)' });
  assert.equal(calls.length, 1);
  const body = calls[0][1][1].replace(/^display notification "|" with title "Sauron Eye"$/g, '');
  // AppleScript string-literal escapes are " and \ — neither may survive sanitize
  assert.ok(!/["\\]/.test(body), body);
});

test('notifier: no-op off darwin', (t) => {
  const r = makeRegistry(t);
  const calls = [];
  const stop = createNotifier(r, { platform: 'linux', exec: (...a) => calls.push(a) });
  t.after(() => stop());
  r.ingestHook({ sessionId: 'l1', event: 'notification' });
  assert.equal(calls.length, 0);
});

test('surfaces/cmux: degrades cleanly when binary is missing', async (t) => {
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  t.after(() => { process.env.PATH = saved; });
  assert.deepEqual(await cmux.detect(), { available: false, running: false });
  const r = await cmux.launch({ cwd: tmpdir() });
  assert.equal(r.ok, false);
  assert.match(r.hint, /not installed/);
});

test('surfaces/auto: routing table + unknown via', async (t) => {
  assert.ok(surfaceFor('tmux').launch);
  assert.ok(surfaceFor('cmux').launch);
  assert.equal(surfaceFor('kitty'), null);
  const r = await autoLaunch({ via: 'kitty', cwd: tmpdir() });
  assert.equal(r.ok, false);
  assert.match(r.hint, /unknown surface/);

  // no binaries at all → auto falls through to a hint, still never throws
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  t.after(() => { process.env.PATH = saved; });
  const r2 = await autoLaunch({ cwd: tmpdir() });
  assert.equal(r2.ok, false);
  assert.match(r2.hint, /no surface found/);
});
