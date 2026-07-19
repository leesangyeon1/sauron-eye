import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ponytail: sessions snapshot only, add beats table when charts need history
export function openStore(dbPath = join(homedir(), '.sauron', 'sauron.db')) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    json TEXT,
    last_seen INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    json TEXT
  )`);
  // no UNIQUE on worktree_path: removed rows are tombstones and a re-spawn reuses the path
  db.exec(`CREATE TABLE IF NOT EXISTS worktrees (
    id              TEXT PRIMARY KEY,
    repo_path       TEXT NOT NULL,
    base_branch     TEXT NOT NULL,
    branch          TEXT NOT NULL,
    worktree_path   TEXT NOT NULL,
    preset_id       TEXT,
    session_id      TEXT,
    status          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    last_checked_at INTEGER,
    swarm_id        TEXT,
    prompt          TEXT
  )`);
  // pre-swarm DBs lack the two columns — ALTER is idempotent-by-catch
  for (const col of ['swarm_id TEXT', 'prompt TEXT']) {
    try { db.exec(`ALTER TABLE worktrees ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  const upsert = db.prepare(`INSERT INTO sessions (session_id, json, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET json = excluded.json, last_seen = excluded.last_seen`);
  const selectAll = db.prepare('SELECT json FROM sessions');
  const kvUpsert = db.prepare(`INSERT INTO kv (key, json) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET json = excluded.json`);
  const kvSelect = db.prepare('SELECT json FROM kv WHERE key = ?');
  const wtUpsert = db.prepare(`INSERT INTO worktrees
    (id, repo_path, base_branch, branch, worktree_path, preset_id, session_id, status, created_at, ended_at, last_checked_at, swarm_id, prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      repo_path = excluded.repo_path, base_branch = excluded.base_branch, branch = excluded.branch,
      worktree_path = excluded.worktree_path, preset_id = excluded.preset_id, session_id = excluded.session_id,
      status = excluded.status, created_at = excluded.created_at, ended_at = excluded.ended_at,
      last_checked_at = excluded.last_checked_at, swarm_id = excluded.swarm_id, prompt = excluded.prompt`);
  const wtAll = db.prepare('SELECT * FROM worktrees');

  return {
    loadSessions() {
      return selectAll.all()
        .map((r) => { try { return JSON.parse(r.json); } catch { return null; } })
        .filter(Boolean);
    },
    saveSession(s) {
      if (!s?.sessionId) return;
      upsert.run(s.sessionId, JSON.stringify(s), s.lastSeen ?? Date.now());
    },
    kvGet(key) {
      const row = kvSelect.get(String(key));
      if (!row) return null;
      try { return JSON.parse(row.json); } catch { return null; }
    },
    kvSet(key, val) {
      kvUpsert.run(String(key), JSON.stringify(val ?? null));
    },
    loadWorktrees() {
      return wtAll.all().map((r) => ({
        id: r.id, repoPath: r.repo_path, baseBranch: r.base_branch, branch: r.branch,
        worktreePath: r.worktree_path, presetId: r.preset_id, sessionId: r.session_id,
        status: r.status, createdAt: r.created_at, endedAt: r.ended_at, lastCheckedAt: r.last_checked_at,
        swarmId: r.swarm_id, prompt: r.prompt,
      }));
    },
    saveWorktree(w) {
      if (!w?.id) return;
      wtUpsert.run(w.id, w.repoPath, w.baseBranch, w.branch, w.worktreePath,
        w.presetId ?? null, w.sessionId ?? null, w.status, w.createdAt,
        w.endedAt ?? null, w.lastCheckedAt ?? null, w.swarmId ?? null, w.prompt ?? null);
    },
    close() { db.close(); },
  };
}
