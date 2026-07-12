import http from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createRegistry } from './registry.js';

const readFileP = promisify(readFile);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public');
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BODY_LIMIT = 256 * 1024;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// adapters/claude.js may not exist yet or may be broken — never let that kill live serving
let adapterPromise = null;
function adapter() {
  adapterPromise ??= import('../adapters/claude.js').catch(() => null);
  return adapterPromise.then((m) => m ?? { backfillSessions: async () => [], sessionName: async () => null });
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { req.destroy(); resolve(null); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export async function startServer({ port, dbPath } = {}) {
  port ??= Number(process.env.SAURON_PORT) || 4870;
  const store = openStore(dbPath ?? process.env.SAURON_DB);
  const registry = createRegistry(store);
  const sseClients = new Set();
  const nameCache = new Map(); // ponytail: caches nulls forever too; restart to pick up late names

  async function decorate(list) {
    const a = await adapter();
    await Promise.all(list.map(async (s) => {
      if (s.name != null) return;
      if (!nameCache.has(s.sessionId)) {
        nameCache.set(s.sessionId, await a.sessionName(s.sessionId).catch(() => null));
      }
      s.name = nameCache.get(s.sessionId);
    }));
    return list;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const [rawPath] = req.url.split('?');
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'POST' && (rawPath === '/ingest/statusline' || rawPath === '/ingest/hook')) {
        const body = await readBody(req);
        if (body === null) return json(res, 413, { ok: false, error: 'body too large' });
        let payload = {};
        try { payload = JSON.parse(body); } catch { /* lenient: bad JSON = empty beat */ }
        if (rawPath === '/ingest/statusline') registry.ingestStatusline(payload);
        else registry.ingestHook(payload);
        return json(res, 200, { ok: true });
      }

      if (req.method !== 'GET') return json(res, 404, { ok: false, error: 'not found' });

      if (rawPath === '/api/health') {
        return json(res, 200, { ok: true, version: VERSION, sessions: registry.sessions().length });
      }

      if (rawPath === '/api/quota') {
        return json(res, 200, { providers: registry.quota() });
      }

      if (rawPath === '/api/sessions') {
        let list = registry.sessions();
        if (url.searchParams.get('include') === 'history') {
          const a = await adapter();
          const hist = await a.backfillSessions().catch(() => []);
          const live = new Set(list.map((s) => s.sessionId));
          for (const h of hist ?? []) {
            if (h?.sessionId && !live.has(h.sessionId)) list.push({ ...h, state: 'ended', source: 'history' });
          }
          list.sort((x, y) => (x.source === y.source ? (y.lastSeen ?? 0) - (x.lastSeen ?? 0) : x.source === 'live' ? -1 : 1));
        }
        return json(res, 200, { sessions: await decorate(list) });
      }

      if (rawPath === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        for (const s of registry.sessions()) send('session', s); // snapshot replay
        send('quota', registry.quota());
        const unsub = registry.subscribe(({ type, data }) => send(type, data));
        sseClients.add(res);
        req.on('close', () => { unsub(); sseClients.delete(res); });
        return;
      }

      // static: web/public with strict traversal guard on the RAW path
      let filePath = decodeURIComponent(rawPath);
      if (filePath === '/') filePath = '/index.html';
      const resolved = path.resolve(PUBLIC_DIR, '.' + filePath);
      if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
        return json(res, 403, { ok: false, error: 'forbidden' });
      }
      try {
        const data = await readFileP(resolved);
        res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
        res.end(data);
      } catch {
        json(res, 404, { ok: false, error: 'not found' });
      }
    } catch (err) {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(err?.message ?? err) });
      else res.end();
    }
  });

  const sweeper = setInterval(() => registry.sweep(), 30_000);
  sweeper.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    close() {
      clearInterval(sweeper);
      for (const res of sseClients) res.destroy();
      return new Promise((resolve) => server.close(() => { store.close(); resolve(); }));
    },
  };
}
