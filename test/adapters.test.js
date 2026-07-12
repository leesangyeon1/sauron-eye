import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_JS = join(HERE, '..', 'collectors', 'hook.js');
const PROVIDERS = ['codex', 'gemini', 'cursor', 'antigravity'];

async function checkShapes(t) {
  for (const name of PROVIDERS) {
    const a = await import(`../adapters/${name}.js`);
    const d = await a.detect();
    assert.equal(typeof d.installed, 'boolean', `${name}: detect().installed is boolean`);
    const s = await a.backfillSessions();
    assert.ok(Array.isArray(s), `${name}: backfillSessions() is array`);
    for (const e of s.slice(0, 3)) {
      assert.equal(e.provider, name, `${name}: entry provider`);
      assert.equal(e.source, 'history', `${name}: entry source`);
      assert.equal(typeof e.sessionId, 'string', `${name}: entry sessionId`);
      assert.equal(typeof e.lastSeen, 'number', `${name}: entry lastSeen`);
    }
  }
}

test('adapters: never throw, shapes match contract (real HOME)', checkShapes);

test('adapters: never throw with HOME pointing at empty dir', async (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'sauron-empty-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = empty; // os.homedir() follows $HOME on POSIX
  try { await checkShapes(t); } finally { process.env.HOME = oldHome; }
});

function runHook(arg, stdinJson, env) {
  return new Promise((res) => {
    // SAURON_HOOK_TIMEOUT_MS: cold-start node + localhost connect can exceed the 50ms
    // production budget on a loaded machine — the test asserts delivery, not the budget
    const child = spawn(process.execPath, [HOOK_JS, arg],
      { env: { ...process.env, SAURON_HOOK_TIMEOUT_MS: '2000', ...env } });
    child.stdin.end(stdinJson);
    child.on('close', (code) => res(code));
  });
}

test('hook.js: pre_tool_use → meta.tool_name sent, huge tool_input truncated, exit 0', async () => {
  let received;
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { received = JSON.parse(b); res.end('{"ok":true}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const stdin = JSON.stringify({
    session_id: 's-hook-test', cwd: '/tmp/x',
    tool_name: 'Bash', tool_use_id: 'tu-1',
    tool_input: { command: 'x'.repeat(2000) }, // >512B after stringify
  });
  const code = await runHook('pre_tool_use', stdin, { SAURON_PORT: String(srv.address().port) });
  srv.close();

  assert.equal(code, 0, 'exit 0');
  assert.ok(received, 'daemon received POST');
  assert.equal(received.event, 'pre_tool_use');
  assert.equal(received.provider, 'claude');
  assert.equal(received.sessionId, 's-hook-test');
  assert.equal(received.meta.tool_name, 'Bash');
  assert.equal(received.meta.tool_use_id, 'tu-1');
  assert.deepEqual(received.meta.tool_input, { truncated: true }, 'oversized tool_input replaced');
});

test('hook.js: small tool_input passes through intact', async () => {
  let received;
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { received = JSON.parse(b); res.end('{"ok":true}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const stdin = JSON.stringify({ session_id: 's2', tool_name: 'Read', tool_input: { file: '/a' } });
  const code = await runHook('post_tool_use', stdin, { SAURON_PORT: String(srv.address().port) });
  srv.close();

  assert.equal(code, 0);
  assert.deepEqual(received.meta.tool_input, { file: '/a' });
});

test('hook.js: daemon down → exit 0, no crash', async () => {
  const code = await runHook('stop', '{"session_id":"s3"}', { SAURON_PORT: '1' }); // nothing listens on :1
  assert.equal(code, 0);
});
