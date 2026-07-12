const STALE_MS = 5 * 60_000;

const HOOK_STATE = {
  session_start: 'working',
  user_prompt_submit: 'working',
  stop: 'idle',
  notification: 'needs_input',
  session_end: 'ended',
};

export function createRegistry(store) {
  const sessions = new Map();
  for (const s of store.loadSessions()) if (s?.sessionId) sessions.set(s.sessionId, s);
  const subs = new Set();
  const staleNotified = new Set();

  const emit = (type, data) => { for (const fn of subs) fn({ type, data }); };

  function withState(s) {
    const state = s.state !== 'ended' && Date.now() - s.lastSeen > STALE_MS ? 'stale' : s.state;
    return { ...s, state };
  }

  function get(id, ts) {
    let s = sessions.get(id);
    if (!s) {
      // new session (first beat or hook) starts as working
      s = { sessionId: id, state: 'working', name: null, firstSeen: ts, lastSeen: ts, source: 'live' };
      sessions.set(id, s);
    }
    return s;
  }

  function touch(s, ts) {
    s.lastSeen = Math.max(s.lastSeen ?? ts, ts);
    staleNotified.delete(s.sessionId);
  }

  function save(s) {
    store.saveSession(s);
    emit('session', withState(s));
  }

  function quota() {
    // ponytail: single provider; key by provider field when a second adapter lands
    let latest = null;
    for (const s of sessions.values()) {
      if (!s.rate5h && !s.rate7d) continue;
      if (!latest || s.lastSeen > latest.lastSeen) latest = s;
    }
    if (!latest) return {};
    return { claude: { rate5h: latest.rate5h ?? null, rate7d: latest.rate7d ?? null, asOf: latest.lastSeen } };
  }

  return {
    ingestStatusline(p) {
      p ??= {}; // default param misses explicit null
      const id = p.sessionId;
      if (!id) return;
      const ts = typeof p.ts === 'number' ? p.ts : Date.now();
      const s = get(id, ts);
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
      if (p.cwd) s.cwd = p.cwd;
      touch(s, ts);
      const next = Object.hasOwn(HOOK_STATE, p.event) ? HOOK_STATE[p.event] : undefined;
      // explicit start/prompt hooks resurrect ended sessions (API.md: only beats are barred)
      if (next && (s.state !== 'ended' || p.event === 'session_start' || p.event === 'user_prompt_submit')) s.state = next;
      save(s);
    },

    sessions() {
      return [...sessions.values()].map(withState).sort((a, b) => b.lastSeen - a.lastSeen);
    },

    quota,

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
