const STALE_MS = 5 * 60_000;
const ACTIVITY_SAVE_MS = 2_000; // tool hooks are high-frequency; persist activity at most every 2s
const CAPS = { open: 10, recent: 20, skills: 30, agents: 20, mcp: 20 };

const HOOK_STATE = {
  session_start: 'working',
  user_prompt_submit: 'working',
  stop: 'idle',
  notification: 'needs_input',
  session_end: 'ended',
};

const ACTIVITY_EVENTS = new Set(['pre_tool_use', 'post_tool_use', 'subagent_stop']);

function mcpServer(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null;
  const parts = name.split('__'); // mcp__<server>__<tool>
  return parts.length >= 3 && parts[1] ? parts[1] : null;
}

// mutates s.activity per API.md v2 interpretation rules; returns true if anything changed
function applyActivity(s, event, meta, ts) {
  meta ??= {};
  const a = (s.activity ??= { openTools: [], recentTools: [], skills: [], agents: [], mcpServers: [] });
  const pushRecent = (entry) => {
    a.recentTools.unshift(entry); // newest first
    if (a.recentTools.length > CAPS.recent) a.recentTools.length = CAPS.recent;
  };

  if (event === 'pre_tool_use') {
    const name = meta.tool_name;
    if (!name) return false;
    const server = mcpServer(name);
    const input = meta.tool_input ?? {};
    a.openTools.push({ name, server, tool_use_id: meta.tool_use_id ?? null, startedAt: ts });
    while (a.openTools.length > CAPS.open) {
      const old = a.openTools.shift(); // overflow: oldest auto-closed without ms (missed its post hook)
      pushRecent({ name: old.name, server: old.server, ms: null, endedAt: null });
    }
    if (server && !a.mcpServers.includes(server) && a.mcpServers.length < CAPS.mcp) a.mcpServers.push(server);
    if (name === 'Skill') {
      const skill = input.skill ?? input.name ?? input.command;
      if (skill) {
        const hit = a.skills.find((x) => x.name === skill);
        if (hit) { hit.count += 1; hit.lastUsed = ts; }
        else {
          a.skills.push({ name: skill, count: 1, lastUsed: ts });
          if (a.skills.length > CAPS.skills) {
            // drop least-recently-used
            a.skills.splice(a.skills.reduce((m, x, i, arr) => (x.lastUsed < arr[m].lastUsed ? i : m), 0), 1);
          }
        }
      }
    }
    if (name === 'Task') {
      a.agents.push({ type: input.subagent_type ?? null, startedAt: ts, endedAt: null });
      if (a.agents.length > CAPS.agents) {
        // evict oldest CLOSED entry first — never drop a running agent while finished ones remain
        const i = a.agents.findIndex((x) => x.endedAt != null);
        a.agents.splice(i >= 0 ? i : 0, 1);
      }
    }
    return true;
  }

  if (event === 'post_tool_use') {
    let i = -1;
    if (meta.tool_use_id) i = a.openTools.findIndex((t) => t.tool_use_id === meta.tool_use_id);
    // FIFO name fallback: parallel same-name calls complete in issue order (no nesting in Claude Code)
    if (i < 0 && meta.tool_name) i = a.openTools.findIndex((t) => t.name === meta.tool_name);
    if (i < 0) return false;
    const [t] = a.openTools.splice(i, 1);
    pushRecent({ name: t.name, server: t.server, ms: Math.max(0, ts - t.startedAt), endedAt: ts });
    return true;
  }

  if (event === 'subagent_stop') {
    const open = a.agents.findLast((x) => x.endedAt == null); // newest open agent
    if (!open) return false;
    open.endedAt = ts;
    return true;
  }
  return false;
}

export function createRegistry(store) {
  const sessions = new Map();
  for (const s of store.loadSessions()) if (s?.sessionId) sessions.set(s.sessionId, s);
  const subs = new Set();
  const staleNotified = new Set();
  const saveState = new Map(); // sessionId -> { last, timer } for activity save debounce

  const emit = (type, data) => { for (const fn of subs) fn({ type, data }); };

  function withState(s) {
    const state = s.state !== 'ended' && Date.now() - s.lastSeen > STALE_MS ? 'stale' : s.state;
    return { ...s, state };
  }

  function get(id, ts) {
    let s = sessions.get(id);
    if (!s) {
      // new session (first beat or hook) starts as working; live ingest defaults to claude
      s = { sessionId: id, state: 'working', provider: 'claude', name: null, firstSeen: ts, lastSeen: ts, source: 'live' };
      sessions.set(id, s);
    }
    return s;
  }

  function touch(s, ts) {
    s.lastSeen = Math.max(s.lastSeen ?? ts, ts);
    staleNotified.delete(s.sessionId);
  }

  function save(s) {
    const rec = saveState.get(s.sessionId);
    if (rec?.timer) { clearTimeout(rec.timer); rec.timer = null; }
    saveState.set(s.sessionId, { last: Date.now(), timer: null });
    store.saveSession(s);
    emit('session', withState(s));
  }

  // activity-only changes: emit immediately, persist at most every 2s per session (trailing timer)
  function saveDebounced(s) {
    const id = s.sessionId;
    const rec = saveState.get(id) ?? { last: 0, timer: null };
    const now = Date.now();
    if (now - rec.last >= ACTIVITY_SAVE_MS) {
      rec.last = now;
      store.saveSession(s);
    } else if (!rec.timer) {
      rec.timer = setTimeout(() => {
        rec.timer = null;
        rec.last = Date.now();
        try { store.saveSession(s); } catch { /* store may be closed */ }
      }, ACTIVITY_SAVE_MS - (now - rec.last));
      rec.timer.unref?.();
    }
    saveState.set(id, rec);
  }

  function quota() {
    // latest beat per provider
    const out = {};
    for (const s of sessions.values()) {
      if (!s.rate5h && !s.rate7d) continue;
      const p = s.provider ?? 'claude';
      if (!out[p] || s.lastSeen > out[p].asOf) {
        out[p] = { rate5h: s.rate5h ?? null, rate7d: s.rate7d ?? null, asOf: s.lastSeen };
      }
    }
    return out;
  }

  return {
    // persist every session with a pending debounce timer — call before store.close()
    flush() {
      for (const [id, rec] of saveState) {
        if (!rec.timer) continue;
        clearTimeout(rec.timer);
        rec.timer = null;
        const s = sessions.get(id);
        if (s) { try { store.saveSession(s); } catch { /* store closing */ } }
      }
    },

    ingestStatusline(p) {
      p ??= {}; // default param misses explicit null
      const id = p.sessionId;
      if (!id) return;
      const ts = typeof p.ts === 'number' ? p.ts : Date.now();
      const s = get(id, ts);
      if (typeof p.provider === 'string' && p.provider) s.provider = p.provider;
      if (p.model?.id != null) s.modelId = p.model.id;
      if (p.model?.display_name != null) s.model = p.model.display_name;
      if (p.cost?.total_cost_usd != null) s.costUsd = p.cost.total_cost_usd;
      if (p.context?.used_pct != null) s.contextPct = p.context.used_pct;
      if (p.rate?.five_hour) s.rate5h = { usedPct: p.rate.five_hour.used_pct ?? null, resetsAt: p.rate.five_hour.resets_at ?? null };
      if (p.rate?.seven_day) s.rate7d = { usedPct: p.rate.seven_day.used_pct ?? null, resetsAt: p.rate.seven_day.resets_at ?? null };
      if (p.cwd) s.cwd = p.cwd;
      if (p.git_branch) s.gitBranch = p.git_branch;
      touch(s, ts);
      // beats never resurrect ended sessions; explicit hooks outrank beat inference
      save(s);
      if (p.rate) emit('quota', quota());
    },

    ingestHook(p) {
      p ??= {};
      const id = p.sessionId;
      if (!id) return;
      const ts = typeof p.ts === 'number' ? p.ts : Date.now();
      const s = get(id, ts);
      if (typeof p.provider === 'string' && p.provider) s.provider = p.provider;
      if (p.cwd) s.cwd = p.cwd;
      touch(s, ts);
      if (ACTIVITY_EVENTS.has(p.event)) {
        if (applyActivity(s, p.event, p.meta, ts)) emit('session', withState(s));
        saveDebounced(s); // lastSeen moved even without a mutation
        return;
      }
      // stop/session_end close everything still open (API.md: openTools는 post/stop으로 닫힘);
      // dropped post_tool_use/subagent_stop hooks are expected (50ms budget) — flush here
      if ((p.event === 'stop' || p.event === 'session_end') && s.activity) {
        const a = s.activity;
        for (const t of a.openTools.splice(0)) {
          a.recentTools.unshift({ name: t.name, server: t.server, ms: Math.max(0, ts - t.startedAt), endedAt: ts });
        }
        if (a.recentTools.length > CAPS.recent) a.recentTools.length = CAPS.recent;
        for (const g of a.agents) if (g.endedAt == null) g.endedAt = ts;
      }
      const next = Object.hasOwn(HOOK_STATE, p.event) ? HOOK_STATE[p.event] : undefined;
      // explicit start/prompt hooks resurrect ended sessions (API.md: only beats are barred)
      if (next && (s.state !== 'ended' || p.event === 'session_start' || p.event === 'user_prompt_submit')) s.state = next;
      save(s);
    },

    sessions() {
      return [...sessions.values()].map(withState).sort((a, b) => b.lastSeen - a.lastSeen);
    },

    quota,

    // providers: [{ provider, label, detect: { installed, version?, plan? } }] injected by server
    groups({ providers = [] } = {}) {
      const byProvider = new Map();
      for (const s of sessions.values()) {
        const p = s.provider ?? 'claude';
        if (!byProvider.has(p)) byProvider.set(p, []);
        byProvider.get(p).push(withState(s));
      }
      const meta = new Map(providers.map((p) => [p?.provider, p]).filter(([k]) => k));
      const out = [];
      for (const name of new Set([...byProvider.keys(), ...meta.keys()])) {
        const list = (byProvider.get(name) ?? []).sort((a, b) => b.lastSeen - a.lastSeen);
        const det = meta.get(name)?.detect ?? {};
        if (!list.length && !det.installed) continue; // uninstalled + sessionless: skip
        let latest = null;
        let cost = 0;
        for (const s of list) {
          cost += s.costUsd ?? 0;
          if ((s.rate5h || s.rate7d) && (!latest || s.lastSeen > latest.lastSeen)) latest = s;
        }
        out.push({
          provider: name,
          label: meta.get(name)?.label ?? name,
          installed: det.installed ?? list.length > 0,
          version: det.version ?? null,
          plan: det.plan ?? null,
          usage: { rate5h: latest?.rate5h ?? null, rate7d: latest?.rate7d ?? null, costUsd: cost },
          sessions: list,
        });
      }
      out.sort((a, b) => b.sessions.length - a.sessions.length || String(a.label).localeCompare(String(b.label)));
      return out;
    },

    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },

    sweep() {
      for (const s of sessions.values()) {
        if (s.state === 'ended' || staleNotified.has(s.sessionId)) continue;
        if (Date.now() - s.lastSeen > STALE_MS) {
          staleNotified.add(s.sessionId);
          emit('session', withState(s));
        }
      }
    },
  };
}
