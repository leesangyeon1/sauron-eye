// Wire lifecycle collectors into codex / gemini / grok so their sessions show up
// live in sauron alongside Claude Code. Each CLI has its own config format and hook
// system (verified 2026-07); we touch only our own entries and back up first.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_JS = join(HERE, 'hook.js');
const CODEX_NOTIFY = join(HERE, 'codex-notify.js');
const home = () => process.env.SAURON_FAKE_HOME || homedir();
const sauronHome = () => process.env.SAURON_HOME || join(home(), '.sauron');
const hookCmd = (event, provider) => `node ${JSON.stringify(HOOK_JS)} ${event} ${provider}`;

function backup(path, text) {
  const dir = join(sauronHome(), 'backups');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${path.split('/').pop()}.${new Date().toISOString()}`), text);
}

// Gemini: JSON settings.json, same hook shape as Claude but its own event names.
// { hooks: { <Event>: [ { matcher, hooks:[{type:command,command,timeout}] } ] } }
const GEMINI_EVENTS = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Notification: 'notification',
  BeforeTool: 'pre_tool_use',
  AfterTool: 'post_tool_use',
};
function installGemini() {
  const path = join(home(), '.gemini', 'settings.json');
  if (!existsSync(dirname(path))) return { agent: 'gemini', installed: false, reason: 'no ~/.gemini (gemini CLI not set up)' };
  let text = null, settings = {};
  if (existsSync(path)) {
    text = readFileSync(path, 'utf8');
    try { settings = JSON.parse(text); } catch (e) { return { agent: 'gemini', installed: false, reason: `cannot parse ${path}: ${e.message}` }; }
  }
  settings.hooks ||= {};
  for (const [ev, our] of Object.entries(GEMINI_EVENTS)) {
    const cmd = hookCmd(our, 'gemini');
    const arr = (settings.hooks[ev] ||= []);
    if (!arr.some((e) => (e.hooks || []).some((h) => h.command === cmd)))
      arr.push({ matcher: '*', hooks: [{ name: 'sauron', type: 'command', command: cmd, timeout: 5000 }] });
  }
  if (text != null) backup(path, text);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  return { agent: 'gemini', installed: true, path };
}

// Grok: JSON hook files under ~/.grok/hooks/. Claude-compatible event names + stdin JSON.
const GROK_EVENTS = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'stop',
  Notification: 'notification',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  SubagentStop: 'subagent_stop',
};
function installGrok() {
  const dir = join(home(), '.grok');
  if (!existsSync(dir)) return { agent: 'grok', installed: false, reason: 'no ~/.grok (grok CLI not set up)' };
  const hooksDir = join(dir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const doc = { hooks: {} };
  for (const [ev, our] of Object.entries(GROK_EVENTS)) {
    doc.hooks[ev] = [{ hooks: [{ type: 'command', command: hookCmd(our, 'grok') }] }];
  }
  const path = join(hooksDir, 'sauron.json');
  if (existsSync(path)) backup(path, readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  return { agent: 'grok', installed: true, path };
}

// Codex: TOML config.toml, single top-level `notify` array. TOML has no zero-dep parser
// here, so we only ADD notify when absent — never rewrite a user's existing one.
function installCodex() {
  const dir = join(home(), '.codex');
  if (!existsSync(dir) && !existsSync(join(home(), '.codex'))) return { agent: 'codex', installed: false, reason: 'no ~/.codex (codex CLI not set up)' };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.toml');
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (/^\s*notify\s*=/m.test(text)) {
    return { agent: 'codex', installed: false, reason: 'config.toml already has a `notify` — edit it by hand to add sauron', path };
  }
  const line = `notify = ["node", ${JSON.stringify(CODEX_NOTIFY)}]`;
  if (text) backup(path, text);
  writeFileSync(path, (text && !text.endsWith('\n') ? text + '\n' : text) + line + '\n');
  return { agent: 'codex', installed: true, path, note: 'turn-complete only — codex sessions show working↔idle, no session end' };
}

export async function installAgents() {
  return [installCodex(), installGemini(), installGrok()];
}
