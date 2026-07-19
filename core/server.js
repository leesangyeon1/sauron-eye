import http from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createRegistry } from './registry.js';
import { createWorktreeManager } from './worktree.js';
import { createNotifier } from './notifier.js';
import { MCP_CATALOG } from './mcp-catalog.js';
import * as autoSurface from '../surfaces/auto.js';

const readFileP = promisify(readFile);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public');
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BODY_LIMIT = 256 * 1024;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const PROVIDERS = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['gemini', 'Gemini CLI'],
  ['cursor', 'Cursor'],
  ['antigravity', 'Antigravity'],
];

// adapters are the quarantine zone (DESIGN.md §1): any of them may be missing or broken —
// dynamic import + catch so a bad adapter can never kill live serving
const adapterCache = new Map();
function loadAdapter(name) {
  if (!adapterCache.has(name)) adapterCache.set(name, import(`../adapters/${name}.js`).catch(() => null));
  return adapterCache.get(name);
}
function adapter() {
  return loadAdapter('claude').then((m) => m ?? { backfillSessions: async () => [], sessionName: async () => null });
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

export async function startServer({ port, dbPath, worktreeRoot, fridgeUrl } = {}) {
  port ??= Number(process.env.SAURON_PORT) || 4870;
  fridgeUrl ??= process.env.SAURON_FRIDGE_URL || 'http://127.0.0.1:4924';
  const store = openStore(dbPath ?? process.env.SAURON_DB);
  const registry = createRegistry(store);
  // auto surface routes cmux > tmux per launch; degrades to { ok:false, hint } when neither exists
  const worktrees = createWorktreeManager(store, registry, { root: worktreeRoot, surface: autoSurface, fridgeUrl });
  const stopNotifier = createNotifier(registry); // darwin-only needs_input notifications, SAURON_NOTIFY=0 off
  const sseClients = new Set();
  const nameCache = new Map(); // ponytail: caches nulls forever too; restart to pick up late names

  let detectCache = null; // ponytail: fixed 60s TTL, refreshed lazily on /api/groups hits
  async function detectProviders() {
    if (detectCache && Date.now() - detectCache.at < 60_000) return detectCache.providers;
    const providers = await Promise.all(PROVIDERS.map(async ([provider, label]) => {
      let detect = { installed: false };
      try {
        const m = await loadAdapter(provider);
        detect = (await m?.detect?.()) ?? { installed: false };
      } catch { /* adapters must never throw, but belt and suspenders */ }
      return { provider, label, detect };
    }));
    detectCache = { at: Date.now(), providers };
    return providers;
  }

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

      // 127.0.0.1 binding doesn't stop browsers: cross-origin pages can fire CORS
      // "simple" POSTs at us, and DNS rebinding fakes the Host. Loopback-only, both headers.
      const loopback = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h ?? '');
      if (req.headers.origin && !loopback(req.headers.origin.replace(/^https?:\/\//, ''))) {
        return json(res, 403, { ok: false, error: 'forbidden origin' });
      }
      if (req.headers.host && !loopback(req.headers.host)) {
        return json(res, 403, { ok: false, error: 'forbidden host' });
      }

      if (req.method === 'POST' && (rawPath === '/ingest/statusline' || rawPath === '/ingest/hook')) {
        const body = await readBody(req);
        if (body === null) return json(res, 413, { ok: false, error: 'body too large' });
        let payload = {};
        try { payload = JSON.parse(body); } catch { /* lenient: bad JSON = empty beat */ }
        if (rawPath === '/ingest/statusline') registry.ingestStatusline(payload);
        else registry.ingestHook(payload);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'PUT' && rawPath === '/api/map') {
        const body = await readBody(req);
        if (body === null) return json(res, 413, { ok: false, error: 'body too large' });
        let doc;
        try { doc = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
        if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
          return json(res, 400, { ok: false, error: 'nodes/edges arrays required' });
        }
        // x/y are interpolated into SVG attributes client-side — must be numbers, never strings
        for (const n of doc.nodes) {
          const x = Number(n?.x), y = Number(n?.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return json(res, 400, { ok: false, error: 'node x/y must be finite numbers' });
          }
          n.x = x; n.y = y;
        }
        store.kvSet('map', doc); // full-document replace
        return json(res, 200, { ok: true });
      }

      const wtPost = ['/api/worktree/create', '/api/worktree/gc', '/api/swarm/create', '/api/swarm/adopt'];
      if (req.method === 'POST' && wtPost.includes(rawPath)) {
        const body = await readBody(req);
        if (body === null) return json(res, 413, { ok: false, error: 'body too large' });
        let payload;
        try { payload = JSON.parse(body || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
        if (rawPath === '/api/worktree/gc') {
          return json(res, 200, await worktrees.gc({ dryRun: payload.dryRun !== false }));
        }
        if (rawPath === '/api/swarm/adopt') {
          const r = await worktrees.adopt({ winnerId: payload.winnerId });
          return json(res, r.ok ? 200 : 400, r);
        }
        const opts = {
          repoPath: payload.repoPath, branch: payload.branch, baseBranch: payload.baseBranch,
          presetId: payload.presetId, launch: payload.launch !== false, paneTarget: payload.paneTarget,
          via: payload.via,
        };
        const r = rawPath === '/api/swarm/create'
          ? await worktrees.swarm({ ...opts, count: payload.count, prompt: payload.prompt })
          : await worktrees.create(opts);
        return json(res, r.ok ? 200 : 400, r);
      }

      if (req.method === 'DELETE' && rawPath.startsWith('/api/worktree/')) {
        const id = decodeURIComponent(rawPath.slice('/api/worktree/'.length));
        const body = await readBody(req);
        if (body === null) return json(res, 413, { ok: false, error: 'body too large' });
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* lenient: no body = no force */ }
        const r = await worktrees.remove(id, { force: payload.force === true });
        return json(res, r.ok ? 200 : 400, r);
      }

      if (req.method !== 'GET') return json(res, 404, { ok: false, error: 'not found' });

      if (rawPath === '/api/worktree/list') {
        return json(res, 200, { worktrees: worktrees.list() });
      }

      if (rawPath === '/api/worktree/diff') {
        const r = await worktrees.diff(url.searchParams.get('ref') ?? '');
        return json(res, r.ok ? 200 : 400, r);
      }

      if (rawPath === '/api/swarm/list') {
        return json(res, 200, { swarms: worktrees.swarms() });
      }

      // browser can't hit AI-Refrigerator cross-origin — proxy the preset list (soft dependency)
      if (rawPath === '/api/presets') {
        try {
          const r = await fetch(`${fridgeUrl}/api/presets`, { signal: AbortSignal.timeout(1500) });
          const j = await r.json();
          const presets = (j?.data?.presets ?? [])
            .filter((p) => p?.id)
            .map((p) => ({ id: p.id, name: p.name ?? p.id, emoji: p.emoji ?? '' }));
          return json(res, 200, { ok: true, presets });
        } catch {
          return json(res, 200, { ok: true, presets: [] }); // fridge down → empty, UI degrades to free text
        }
      }

      if (rawPath === '/api/groups') {
        const providers = await detectProviders();
        const groups = registry.groups({ providers });
        for (const g of groups) await decorate(g.sessions);
        return json(res, 200, { groups });
      }

      if (rawPath === '/api/map') {
        return json(res, 200, store.kvGet('map') ?? { nodes: [], edges: [] });
      }

      if (rawPath === '/api/mcp/catalog') {
        return json(res, 200, { catalog: MCP_CATALOG });
      }

      if (rawPath === '/api/map/export') {
        const map = store.kvGet('map') ?? {};
        const mcpServers = {};
        for (const n of map.nodes ?? []) {
          if (n?.type !== 'mcp') continue;
          const entry = MCP_CATALOG.find((c) => c.id === n.meta?.catalogId);
          if (entry) mcpServers[entry.id] = entry.config; // placeholders stay "<TOKEN>"
        }
        return json(res, 200, { mcpServers });
      }

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
        // backpressure: v2 activity events fire per tool call — a stalled client must not
        // buffer the daemon into the ground. 3 failed writes → drop; EventSource reconnects.
        let strikes = 0;
        const send = (event, data) => {
          if (res.writableEnded) return;
          if (res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) strikes = 0;
          else if (++strikes >= 3) res.destroy();
        };
        for (const s of registry.sessions()) send('session', s); // snapshot replay
        send('quota', registry.quota());
        for (const w of worktrees.list()) send('worktree', w);
        const unsub = registry.subscribe(({ type, data }) => send(type, data));
        const unsubWt = worktrees.subscribe((w) => send('worktree', w));
        sseClients.add(res);
        req.on('close', () => { unsub(); unsubWt(); sseClients.delete(res); });
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

  const handle = {
    port: server.address().port,
    close() {
      clearInterval(sweeper);
      stopNotifier();
      for (const res of sseClients) res.destroy();
      registry.flush(); // pending debounced activity saves — before the store closes
      return new Promise((resolve) => server.close(() => { store.close(); resolve(); }));
    },
  };
  // graceful shutdown: without this, SIGTERM drops up to 2s of debounced activity
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => handle.close().finally(() => process.exit(0)));
  }
  return handle;
}
