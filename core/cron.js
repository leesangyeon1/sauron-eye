import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Scheduled automations (README 시나리오 C: 야간 spawn) via the user's crontab.
// Our entries are tagged `# sauron:<id>` — we only ever touch tagged lines,
// everything else in the crontab passes through byte-identical.
const execP = promisify(execFile);
const TAG = /\s# sauron:([0-9a-f-]+)$/;

const defaultRead = async () => {
  try { return (await execP('crontab', ['-l'])).stdout; }
  catch (err) {
    if (/no crontab/i.test(String(err?.stderr ?? ''))) return ''; // empty is fine
    throw err;
  }
};
const defaultWrite = async (text) => {
  const p = execP('crontab', ['-']); // promisified execFile exposes .child
  p.child.stdin.end(text);
  await p;
};

// crontab treats % as newline — escape it; args are single-quoted for sh
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`.replaceAll('%', '\\%');

export function validSchedule(s) {
  const t = String(s ?? '').trim();
  if (/^@(hourly|daily|weekly|monthly|reboot)$/.test(t)) return true;
  const f = t.split(/\s+/);
  return f.length === 5 && f.every((x) => /^[0-9*,/-]+$/.test(x));
}

export function createCron({ readTab = defaultRead, writeTab = defaultWrite, binPath, nodePath = process.execPath } = {}) {
  if (!binPath) throw new Error('binPath required');

  async function add({ schedule, args }) {
    if (!validSchedule(schedule)) return { ok: false, error: `invalid cron schedule: "${schedule}" (5 fields or @daily etc.)` };
    if (!Array.isArray(args) || !args.length) return { ok: false, error: 'no command — usage: sauron cron add "<schedule>" -- spawn <repo> …' };
    if (args[0] !== 'spawn') return { ok: false, error: 'only `spawn` can be scheduled (Phase 6)' };
    const id = randomUUID().slice(0, 8);
    const log = join(homedir(), '.sauron', 'cron.log');
    mkdirSync(join(homedir(), '.sauron'), { recursive: true });
    // --ensure-daemon: at 3am nobody started `sauron start` — spawn boots it itself
    const cmd = [nodePath, binPath, ...args, '--ensure-daemon'].map(shq).join(' ');
    const line = `${schedule} ${cmd} >> ${shq(log)} 2>&1 # sauron:${id}`;
    const tab = await readTab();
    await writeTab((tab.endsWith('\n') || tab === '' ? tab : tab + '\n') + line + '\n');
    return { ok: true, id, line };
  }

  async function ls() {
    const tab = await readTab();
    const jobs = [];
    for (const line of tab.split('\n')) {
      const m = TAG.exec(line);
      if (m) jobs.push({ id: m[1], line: line.replace(TAG, '') });
    }
    return { ok: true, jobs };
  }

  async function rm(id) {
    const tab = await readTab();
    const lines = tab.split('\n');
    const kept = lines.filter((l) => TAG.exec(l)?.[1] !== id);
    if (kept.length === lines.length) return { ok: false, error: `no sauron cron job "${id}"` };
    await writeTab(kept.join('\n'));
    return { ok: true, removed: id };
  }

  return { add, ls, rm };
}
