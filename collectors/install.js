// Installer: merge our statusline + hooks into ~/.claude/settings.json.
// Always backup first, never overwrite a file we cannot parse.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'stop',
  Notification: 'notification',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  SubagentStop: 'subagent_stop',
};
const STATUSLINE_CMD = `node ${JSON.stringify(join(HERE, 'statusline.js'))}`;
const HOOK_JS = join(HERE, 'hook.js');
const hookCmd = (ev) => `node ${JSON.stringify(HOOK_JS)} ${ev}`;
// matches our statusline command from ANY checkout path, quoted or not
const IS_SAURON_STATUSLINE = /collectors[\/\\]statusline\.js"?$/;

const claudeDir = () => process.env.SAURON_CLAUDE_DIR || join(homedir(), '.claude');
const sauronHome = () => process.env.SAURON_HOME || join(homedir(), '.sauron');

function loadSettings() {
  const path = join(claudeDir(), 'settings.json');
  if (!existsSync(path)) return { path, text: null, settings: {} };
  const text = readFileSync(path, 'utf8');
  let settings;
  try { settings = JSON.parse(text); } catch (e) {
    throw new Error(`sauron install aborted: cannot parse ${path} (${e.message}); fix or remove it first — refusing to overwrite`);
  }
  return { path, text, settings };
}

function backup(text) {
  if (text == null) return;
  const dir = join(sauronHome(), 'backups');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `settings.json.${new Date().toISOString()}`), text);
}

function loadConfig() {
  try { return JSON.parse(readFileSync(join(sauronHome(), 'config.json'), 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  mkdirSync(sauronHome(), { recursive: true });
  writeFileSync(join(sauronHome(), 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

// ponytail: set-based line diff, not real LCS — plenty for pretty-printed JSON
function printDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const aSet = new Set(a), bSet = new Set(b);
  console.log('--- settings.json (current)');
  console.log('+++ settings.json (after install)');
  for (const l of a) if (!bSet.has(l)) console.log('- ' + l);
  for (const l of b) if (!aSet.has(l)) console.log('+ ' + l);
}

export async function install({ dryRun = false } = {}) {
  const { path, text, settings } = loadSettings();
  const next = structuredClone(settings);

  let chain = null;
  const cur = next.statusLine?.command;
  if (cur !== STATUSLINE_CMD) {
    // never chain a sauron statusline from another checkout — that spawns itself recursively
    if (cur && !IS_SAURON_STATUSLINE.test(cur)) chain = cur;
    next.statusLine = { type: 'command', command: STATUSLINE_CMD };
  }

  next.hooks ||= {};
  for (const [key, ev] of Object.entries(EVENTS)) {
    const cmd = hookCmd(ev);
    const arr = (next.hooks[key] ||= []);
    if (!arr.some((e) => (e.hooks || []).some((h) => h.command === cmd)))
      arr.push({ hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
  }

  const nextText = JSON.stringify(next, null, 2) + '\n';
  if (dryRun) { printDiff(text ?? '', nextText); return; }

  backup(text);
  if (chain) saveConfig({ ...loadConfig(), chainStatusline: chain });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, nextText);
}

export async function uninstall() {
  const { path, text, settings } = loadSettings();
  if (text == null) return; // nothing installed, nothing to restore — don't create files
  const next = structuredClone(settings);
  backup(text);

  const cfg = loadConfig();
  if (IS_SAURON_STATUSLINE.test(next.statusLine?.command || '')) {
    // never "restore" a sauron command a buggy earlier install captured as the chain
    if (cfg.chainStatusline && !IS_SAURON_STATUSLINE.test(cfg.chainStatusline))
      next.statusLine = { type: 'command', command: cfg.chainStatusline };
    else delete next.statusLine;
  }
  delete cfg.chainStatusline;
  saveConfig(cfg);

  for (const key of Object.keys(EVENTS)) {
    const arr = next.hooks?.[key];
    if (!arr) continue;
    next.hooks[key] = arr.filter((e) => !(e.hooks || []).some((h) => (h.command || '').includes(HOOK_JS)));
    if (!next.hooks[key].length) delete next.hooks[key];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;

  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
}
