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
  const upsert = db.prepare(`INSERT INTO sessions (session_id, json, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET json = excluded.json, last_seen = excluded.last_seen`);
  const selectAll = db.prepare('SELECT json FROM sessions');

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
    close() { db.close(); },
  };
}
