import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

// Worktree lifecycle (docs/WORKTREE.md): provisioning → active → pending-cleanup → clean|dirty → removed.
// Hard rule: gc never deletes dirty/unmerged work and never calls `worktree remove --force` /
// `branch -D`. The only forced removal is an explicit remove(ref, {force}) from a human.
const execP = promisify(execFile);
const DEFAULT_ROOT = join(homedir(), '.sauron', 'worktrees');
const DEFAULT_FRIDGE = process.env.SAURON_FRIDGE_URL || 'http://127.0.0.1:4924';
const GC_STATES = ['pending-cleanup', 'clean', 'dirty'];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'x';
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // surfaces run command via shell
const SWARM_MAX = 10;
const PROMPT_MAX = 2000;
const DIFF_CAP = 400_000;
const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const gitErr = (err) => String(err?.stderr || err?.message || err).trim(); // || not ??: ENOENT has stderr === ''

async function git(dir, ...args) {
  const { stdout } = await execP('git', ['-C', dir, ...args]);
  return stdout.trim();
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createWorktreeManager(store, registry, { root = DEFAULT_ROOT, surface = null, fridgeUrl = DEFAULT_FRIDGE } = {}) {
  const rows = new Map(store.loadWorktrees().map((w) => [w.id, w]));
  const subs = new Set();
  const inflight = new Map(); // worktreePath → Promise: concurrent same-branch spawns collapse to one

  const emit = (w) => { for (const fn of subs) fn(pub(w)); };
  const save = (w) => { store.saveWorktree(w); emit(w); };
  const setStatus = (w, status, extra = {}) => { Object.assign(w, extra, { status }); save(w); };
  const pub = (w) => ({
    id: w.id, repoPath: w.repoPath, baseBranch: w.baseBranch, branch: w.branch,
    worktreePath: w.worktreePath, presetId: w.presetId, sessionId: w.sessionId,
    status: w.status, createdAt: w.createdAt, endedAt: w.endedAt,
    swarmId: w.swarmId ?? null, prompt: w.prompt ?? null,
  });
  const claudeCmd = (prompt) => prompt ? `claude ${shq(prompt)}` : 'claude';
  const cmd = (p, prompt) => `cd ${shq(p)} && ${claudeCmd(prompt)}`;
  const session = (id) => registry.sessions().find((s) => s.sessionId === id);
  // a linked session that is stale/ended/vanished no longer owns the worktree
  const orphaned = (w) => { const s = session(w.sessionId); return !s || s.state === 'stale' || s.state === 'ended'; };
  const prune = (repo) => git(repo, 'worktree', 'prune').catch(() => {}); // frees branch + registration of vanished dirs

  // boot reconcile, pass 1 (sync, cheap): vanished directory → tombstone
  for (const w of rows.values()) {
    if (w.status !== 'removed' && !existsSync(w.worktreePath)) { w.status = 'removed'; store.saveWorktree(w); }
  }
  // boot reconcile, pass 2 (async): git is the source of truth, the DB is a cache —
  // prune stale registrations, tombstone rows git no longer knows about
  async function reconcile() {
    const startedAt = Date.now();
    const repos = new Set([...rows.values()].filter((w) => w.status !== 'removed').map((w) => w.repoPath));
    for (const repo of repos) {
      let registered;
      try {
        await prune(repo);
        const out = await git(repo, 'worktree', 'list', '--porcelain');
        registered = new Set(out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9))));
      } catch {
        registered = new Set(); // repo itself gone → none of its worktrees exist
      }
      for (const w of rows.values()) {
        if (w.repoPath !== repo || w.status === 'removed') continue;
        if (w.createdAt > startedAt) continue; // created mid-reconcile — not in our snapshot
        if (!registered.has(w.worktreePath)) setStatus(w, 'removed');
      }
    }
  }
  reconcile().catch(() => {});

  const byPath = (p) => [...rows.values()].find((w) => w.status !== 'removed' && w.worktreePath === p);
  const bySession = (id) => [...rows.values()].find((w) => w.status !== 'removed' && w.sessionId === id);

  // ride the existing registry pub/sub — hooks/collectors/registry stay untouched.
  // SessionStart arrives after `git worktree add` + launch, so the link is lazy by cwd.
  registry.subscribe(({ type, data }) => {
    if (type !== 'session' || !data?.sessionId) return;
    if (data.state === 'ended') {
      const w = bySession(data.sessionId);
      if (w && w.status === 'active') setStatus(w, 'pending-cleanup', { endedAt: Date.now() });
      return;
    }
    // link only on 'working' (SessionStart/prompt/beat) — stale sweep emissions must never (re)link
    if (data.state !== 'working' || !data.cwd) return;
    const w = byPath(real(data.cwd));
    if (!w || (w.sessionId === data.sessionId && w.status === 'active')) return;
    // a different live session already owns this worktree → first one keeps the link
    if (w.status === 'active' && w.sessionId && w.sessionId !== data.sessionId && !orphaned(w)) return;
    setStatus(w, 'active', { sessionId: data.sessionId, endedAt: null }); // covers resume from any non-removed state
  });

  // AI-Refrigerator is a soft dependency: down/failing → warning string, never an error
  async function applyPreset(worktreePath, presetId) {
    try {
      await fetch(`${fridgeUrl}/api/state`, { signal: AbortSignal.timeout(1000) });
    } catch {
      return `preset "${presetId}" skipped — AI-Refrigerator not running at ${fridgeUrl}`;
    }
    try {
      const r = await fetch(`${fridgeUrl}/api/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetId, mode: 'project', projectPath: worktreePath, dryRun: false }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await r.json().catch(() => null);
      if (!body?.ok) return `preset "${presetId}" failed — ${body?.error ?? `HTTP ${r.status}`}`;
      return null;
    } catch (err) {
      return `preset "${presetId}" failed — ${err?.message ?? err}`;
    }
  }

  async function create({ repoPath, branch, baseBranch, presetId, launch = true, paneTarget, via, swarmId, prompt } = {}) {
    if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
    repoPath = repoPath.replace(/^~(?=\/|$)/, homedir()); // web/tui inputs arrive unexpanded
    prompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim().slice(0, PROMPT_MAX) : null;
    let repo;
    try {
      repo = real(await git(resolve(repoPath), 'rev-parse', '--show-toplevel'));
    } catch (err) {
      const bare = await git(resolve(repoPath), 'rev-parse', '--is-bare-repository').catch(() => null);
      if (bare === 'true') return { ok: false, error: `bare repository not supported: ${repoPath}` };
      return { ok: false, error: `not a git repo: ${repoPath} (${gitErr(err)})` };
    }
    const repoSlug = slug(basename(repo));
    branch = typeof branch === 'string' && branch ? branch : `sauron/${repoSlug}-${stamp()}`;
    // path carries a repo hash (same-basename repos must not collide); a slug collision
    // between distinct branches (feat/x vs feat_x) gets a branch-hash suffix
    const repoDir = join(root, `${repoSlug}-${shortHash(repo)}`);
    let wtPath = join(repoDir, slug(branch));
    const sameIdentity = (w) => w.repoPath === repo && w.branch === branch;
    let clash = byPath(wtPath) ?? byPath(real(wtPath));
    if (clash && !sameIdentity(clash)) {
      wtPath = join(repoDir, `${slug(branch)}-${shortHash(branch)}`);
      clash = byPath(wtPath) ?? byPath(real(wtPath));
      if (clash && !sameIdentity(clash)) return { ok: false, error: `worktree path collision at ${wtPath}` };
    }
    if (inflight.has(wtPath)) return inflight.get(wtPath);
    const p = provision();
    inflight.set(wtPath, p);
    try { return await p; } finally { inflight.delete(wtPath); }

    async function provision() {
      const existing = byPath(wtPath) ?? byPath(real(wtPath));
      if (existing && sameIdentity(existing) && existsSync(existing.worktreePath)) {
        // idempotent: same repo+branch spawn returns the existing worktree, creates nothing
        return { ok: true, reused: true, ...pub(existing), command: cmd(existing.worktreePath, existing.prompt), surface: null, warnings: [] };
      }
      mkdirSync(dirname(wtPath), { recursive: true });
      let branchExists = true;
      try { await git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); }
      catch { branchExists = false; }
      try {
        if (branchExists) await git(repo, 'worktree', 'add', wtPath, branch);
        else await git(repo, 'worktree', 'add', '-b', branch, wtPath, baseBranch || 'HEAD');
      } catch (err) {
        return { ok: false, error: `git worktree add failed: ${gitErr(err)}` };
      }
      let base = baseBranch ?? null;
      if (!base) {
        try { base = await git(repo, 'symbolic-ref', '--short', 'HEAD'); } catch { base = 'HEAD'; }
      }
      const w = {
        id: randomUUID(), repoPath: repo, baseBranch: base, branch,
        worktreePath: real(wtPath), presetId: presetId ?? null, sessionId: null,
        status: 'provisioning', createdAt: Date.now(), endedAt: null, lastCheckedAt: null,
        swarmId: swarmId ?? null, prompt,
      };
      rows.set(w.id, w);
      save(w);
      const warnings = [];
      if (presetId) {
        const warn = await applyPreset(w.worktreePath, presetId);
        if (warn) warnings.push(warn);
      }
      let surfaceResult = null;
      if (launch && surface) {
        surfaceResult = await surface
          .launch({ cwd: w.worktreePath, command: claudeCmd(prompt), title: `${repoSlug}-${slug(branch)}`, pane: paneTarget, via })
          .catch((err) => ({ ok: false, hint: String(err?.message ?? err) })); // surface contract says no-throw; belt and suspenders
      }
      return { ok: true, reused: false, ...pub(w), command: cmd(w.worktreePath, prompt), surface: surfaceResult, warnings };
    }
  }

  async function gc({ dryRun = true } = {}) {
    const report = { clean: [], dirty: [], removed: [], missing: [], errors: [] };
    for (const w of [...rows.values()]) {
      if (w.status === 'active') {
        if (!orphaned(w)) continue; // truly live session — untouchable
        // session died without a session_end hook (SIGKILL/reboot/daemon down) — unstick it
        setStatus(w, 'pending-cleanup', { endedAt: w.endedAt ?? Date.now() });
      } else if (!GC_STATES.includes(w.status)) continue; // dirty re-checked every run: commit+merge flips it clean
      w.lastCheckedAt = Date.now();
      if (!existsSync(w.worktreePath)) {
        setStatus(w, 'removed');
        await prune(w.repoPath); // free the branch + stale registration for future re-spawn
        report.missing.push(pub(w));
        continue;
      }
      let uncommitted;
      try {
        uncommitted = (await git(w.worktreePath, 'status', '--porcelain')).length > 0;
      } catch (err) {
        report.errors.push({ id: w.id, branch: w.branch, error: gitErr(err) });
        continue;
      }
      let merged;
      try {
        // refs/heads/ so a same-named tag can never shadow the branch we created
        await git(w.repoPath, 'merge-base', '--is-ancestor', `refs/heads/${w.branch}`, w.baseBranch);
        merged = true;
      } catch (err) {
        if (err?.code === 1) merged = false; // exit 1 = genuinely not merged
        else { // exit 128 etc = base/branch ref gone — a real error, not "unmerged"
          report.errors.push({ id: w.id, branch: w.branch, error: `merged-check failed: ${gitErr(err)} — base "${w.baseBranch}" missing?` });
          continue;
        }
      }
      // a session may have attached during the awaited git calls — never touch it (TOCTOU)
      if (!GC_STATES.includes(w.status)) continue;
      if (uncommitted || !merged) {
        setStatus(w, 'dirty');
        report.dirty.push({ ...pub(w), uncommitted, unmerged: !merged });
        continue;
      }
      setStatus(w, 'clean');
      if (dryRun) { report.clean.push(pub(w)); continue; }
      try {
        await git(w.repoPath, 'worktree', 'remove', w.worktreePath); // never --force
      } catch (err) {
        report.errors.push({ id: w.id, branch: w.branch, error: `worktree remove failed: ${gitErr(err)}` });
        continue;
      }
      try {
        await git(w.repoPath, 'branch', '-d', w.branch); // never -D
      } catch {
        // branch -d checks merged-into-HEAD/upstream, not our base — refusal here is expected
        // when the main checkout sits elsewhere; the work IS merged (we verified), so just note it
        report.errors.push({ id: w.id, branch: w.branch, error: `branch -d ${w.branch} refused — merged into ${w.baseBranch}, delete manually if wanted` });
      }
      setStatus(w, 'removed');
      report.removed.push(pub(w));
    }
    return report;
  }

  async function remove(ref, { force = false } = {}) {
    const w = rows.get(ref) ?? byPath(real(String(ref)));
    if (!w || w.status === 'removed') return { ok: false, error: 'worktree not found' };
    if (w.status === 'active' && !orphaned(w)) return { ok: false, error: 'session still active — end it first' };
    if (!existsSync(w.worktreePath)) {
      setStatus(w, 'removed');
      await prune(w.repoPath);
      return { ok: true, removed: true, note: 'directory already gone' };
    }
    let dirty = true; // status check failing counts as dirty — refuse rather than guess
    try { dirty = (await git(w.worktreePath, 'status', '--porcelain')).length > 0; } catch { /* keep dirty=true */ }
    if (dirty && !force) return { ok: false, error: `dirty — uncommitted changes in ${w.worktreePath}; rerun with force` };
    if (w.status === 'active' && !orphaned(w)) return { ok: false, error: 'session attached during removal — aborted' }; // TOCTOU re-check
    try {
      // explicit human force is the ONE place --force is allowed (docs/WORKTREE.md §3.7)
      await git(w.repoPath, 'worktree', 'remove', ...(force ? ['--force'] : []), w.worktreePath);
    } catch (err) {
      return { ok: false, error: `git worktree remove failed: ${gitErr(err)}` };
    }
    setStatus(w, 'removed');
    // the branch always survives remove(): `branch -d` on unmerged work would fail, -D is banned
    return { ok: true, removed: true, note: `branch "${w.branch}" kept — delete with: git -C ${w.repoPath} branch -d ${w.branch}` };
  }

  // N parallel attempts at the same task: branches <base>-a … -<n>, same prompt, one swarmId.
  // README §7 시나리오 B: compare in the diff view → adopt one → losers cleaned up.
  async function swarm({ repoPath, branch, baseBranch, presetId, count, prompt, via, paneTarget, launch = true } = {}) {
    count = Math.floor(Number(count) || 0);
    if (count < 2 || count > SWARM_MAX) return { ok: false, error: `swarm count must be 2..${SWARM_MAX}` };
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'swarm needs a prompt — all members must attempt the same task' };
    const swarmId = randomUUID();
    const baseName = typeof branch === 'string' && branch ? branch : `sauron/swarm-${stamp()}`;
    const members = [];
    for (let i = 0; i < count; i++) {
      const r = await create({
        repoPath, branch: `${baseName}-${String.fromCharCode(97 + i)}`, baseBranch,
        presetId, launch, paneTarget, via, swarmId, prompt,
      });
      members.push(r);
      if (!r.ok) break; // partial swarm reported as-is; user can rm the created ones
    }
    // quota snapshot rides along — N sessions eat N× tokens (README §8 리스크)
    return { ok: members.every((m) => m.ok), swarmId, prompt, members, quota: registry.quota() };
  }

  function swarms() {
    const live = new Map(registry.sessions().map((s) => [s.sessionId, s]));
    const by = new Map();
    for (const w of rows.values()) {
      if (!w.swarmId || w.status === 'removed') continue;
      if (!by.has(w.swarmId)) by.set(w.swarmId, []);
      by.get(w.swarmId).push(w);
    }
    return [...by.entries()].map(([swarmId, ms]) => ({
      swarmId,
      prompt: ms[0].prompt ?? null,
      repoPath: ms[0].repoPath,
      baseBranch: ms[0].baseBranch,
      createdAt: Math.min(...ms.map((m) => m.createdAt)),
      members: ms.sort((a, b) => a.branch.localeCompare(b.branch)).map((w) => {
        const s = w.sessionId ? live.get(w.sessionId) : null;
        return { ...pub(w), session: s ? { state: s.state, model: s.model ?? null, costUsd: s.costUsd ?? null } : null };
      }),
    })).sort((a, b) => b.createdAt - a.createdAt);
  }

  // working tree vs base: committed + staged + unstaged in one view (untracked listed separately)
  async function diff(ref) {
    const w = rows.get(ref) ?? byPath(real(String(ref)));
    if (!w || w.status === 'removed') return { ok: false, error: 'worktree not found' };
    if (!existsSync(w.worktreePath)) return { ok: false, error: 'directory gone' };
    try {
      const stat = await git(w.worktreePath, 'diff', '--stat', w.baseBranch);
      const untracked = (await git(w.worktreePath, 'status', '--porcelain'))
        .split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3));
      let body = await git(w.worktreePath, 'diff', w.baseBranch);
      const truncated = body.length > DIFF_CAP;
      if (truncated) body = body.slice(0, DIFF_CAP);
      return { ok: true, id: w.id, branch: w.branch, baseBranch: w.baseBranch, stat, untracked, diff: body, truncated };
    } catch (err) {
      return { ok: false, error: gitErr(err) };
    }
  }

  // adopt = merge the winner into its base + force-remove the losers' worktrees.
  // Loser BRANCHES survive (never -D) — response carries manual delete commands.
  async function adopt({ winnerId } = {}) {
    const w = rows.get(winnerId);
    if (!w || w.status === 'removed') return { ok: false, error: 'winner not found' };
    if (!w.swarmId) return { ok: false, error: 'not a swarm member' };
    if (!existsSync(w.worktreePath)) return { ok: false, error: 'winner directory gone' };
    try {
      if ((await git(w.worktreePath, 'status', '--porcelain')).length > 0) {
        return { ok: false, error: 'winner has uncommitted changes — commit in that session first' };
      }
      // merge needs the primary checkout ON the base branch and clean — refuse otherwise, never juggle refs behind git's back
      let cur = null;
      try { cur = await git(w.repoPath, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached */ }
      if (cur !== w.baseBranch) {
        return { ok: false, error: `repo checkout is on "${cur ?? 'detached HEAD'}" — checkout ${w.baseBranch} first, or merge manually: git merge ${w.branch}` };
      }
      if ((await git(w.repoPath, 'status', '--porcelain')).length > 0) {
        return { ok: false, error: 'repo working tree is dirty — commit/stash first' };
      }
      try {
        await git(w.repoPath, 'merge', '--no-ff', '-m', `sauron swarm adopt: ${w.branch}`, w.branch);
      } catch (err) {
        await git(w.repoPath, 'merge', '--abort').catch(() => {});
        return { ok: false, error: `merge failed (aborted, repo untouched) — resolve manually: git merge ${w.branch} · ${gitErr(err)}` };
      }
    } catch (err) {
      return { ok: false, error: gitErr(err) };
    }
    // decision made: the merged winner worktree is done — hand it to gc unless a live session still sits in it
    if (w.status !== 'active' || orphaned(w)) setStatus(w, 'pending-cleanup', { endedAt: w.endedAt ?? Date.now() });
    const losers = [...rows.values()].filter((x) => x.swarmId === w.swarmId && x.id !== w.id && x.status !== 'removed');
    const losersRemoved = [], losersSkipped = [];
    for (const l of losers) {
      const r = await remove(l.id, { force: true }); // discarded by decision; live sessions still refuse inside remove()
      if (r.ok) losersRemoved.push({ id: l.id, branch: l.branch });
      else losersSkipped.push({ id: l.id, branch: l.branch, error: r.error });
    }
    return {
      ok: true, merged: w.branch, into: w.baseBranch,
      losersRemoved, losersSkipped,
      branchCleanup: losers.map((l) => `git -C ${l.repoPath} branch -D ${l.branch}`), // manual by design
    };
  }

  function list() {
    const live = new Map(registry.sessions().map((s) => [s.sessionId, s]));
    return [...rows.values()]
      .filter((w) => w.status !== 'removed')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((w) => {
        const s = w.sessionId ? live.get(w.sessionId) : null;
        return { ...pub(w), session: s ? { state: s.state, model: s.model ?? null, costUsd: s.costUsd ?? null } : null };
      });
  }

  return {
    create,
    swarm,
    swarms,
    diff,
    adopt,
    gc,
    remove,
    list,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
