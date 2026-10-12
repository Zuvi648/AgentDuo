// Umgebungserkennung: CLI-Pfade, Versionen, Anmeldestatus und Authentifizierungskonflikte.
// Liest niemals Token-Dateien – der Status kommt ausschließlich von den CLIs selbst.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthInfo, CliInfo, EnvReport, Settings } from '../shared/types';
import type { ProcessManager } from './proc';

const isWin = process.platform === 'win32';
const home = os.homedir();

// Variablen, die eine API-Abrechnung oder einen anderen Anbieter erzwingen würden.
export const API_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
];

// Markierungen einer umgebenden Claude-Code-Sitzung (falls Agent Duo aus einer solchen gestartet wurde).
const SESSION_MARKERS = ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID'];

let shellPathCache: string | null = null;

/** GUI-Apps auf macOS erben nur einen Minimal-PATH; hier wird der PATH der Login-Shell ergänzt. */
async function loginShellPath(pm: ProcessManager): Promise<string> {
  if (shellPathCache !== null) return shellPathCache;
  shellPathCache = '';
  if (isWin) return '';
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const r = await pm.run({ cmd: shell, args: ['-ilc', 'printf "__AD__%s__AD__" "$PATH"'], timeoutMs: 5000 });
    const m = /__AD__(.*?)__AD__/s.exec(r.stdout);
    if (m) shellPathCache = m[1];
  } catch {
    /* Shell nicht verfügbar – Standardverzeichnisse reichen */
  }
  return shellPathCache;
}

function extraDirs(): string[] {
  if (isWin) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(home, '.local', 'bin'), path.join(roaming, 'npm'), path.join(local, 'Programs', 'Git', 'cmd'), 'C:\\Program Files\\Git\\cmd'];
  }
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin')];
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) dirs.push(path.join(nvm, v, 'bin'));
  } catch {
    /* kein nvm */
  }
  return dirs;
}

export async function fullPath(pm: ProcessManager): Promise<string> {
  const parts = [...(process.env.PATH || '').split(path.delimiter), ...(await loginShellPath(pm)).split(path.delimiter), ...extraDirs()];
  return [...new Set(parts.filter(Boolean))].join(path.delimiter);
}

/** Mit den Desktop-Apps mitgelieferte CLIs als Rückfall, wenn nichts im PATH liegt. */
function bundledCandidates(name: 'codex' | 'claude' | 'git'): string[] {
  if (process.platform !== 'darwin') return [];
  if (name === 'codex') return ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'];
  if (name === 'claude') {
    const root = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
    const out: string[] = [];
    try {
      const versions = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) for (const h of fs.readdirSync(path.join(root, v))) out.push(path.join(root, v, h, 'claude.app', 'Contents', 'MacOS', 'claude'));
    } catch {
      /* Claude-Desktop nicht installiert */
    }
    return out;
  }
  return [];
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function locate(name: 'codex' | 'claude' | 'git', setting: string, pm: ProcessManager): Promise<Pick<CliInfo, 'path' | 'source' | 'error'>> {
  if (setting.trim()) {
    const p = setting.trim();
    return isFile(p) ? { path: p, source: 'Einstellung' } : { path: null, source: null, error: `Eingestellter Pfad existiert nicht: ${p}` };
  }
  const exts = isWin ? ['.exe'] : [''];
  for (const dir of (await fullPath(pm)).split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return { path: p, source: 'PATH' };
    }
  }
  for (const p of bundledCandidates(name)) if (isFile(p)) return { path: p, source: 'gebündelt' };
  return { path: null, source: null, error: 'Nicht gefunden' };
}

export async function childEnv(settings: Settings, pm: ProcessManager): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: await fullPath(pm) };
  // Abo-Anmeldung ist Standard: API-Schlüssel werden nicht an die CLIs durchgereicht.
  if (!settings.allowApiKeyAuth) for (const k of API_ENV_VARS) delete env[k];
  for (const k of SESSION_MARKERS) delete env[k];
  return env;
}

export function authConflicts(): string[] {
  return API_ENV_VARS.filter((k) => !!process.env[k]);
}

async function cliInfo(name: 'codex' | 'claude' | 'git', setting: string, settings: Settings, pm: ProcessManager): Promise<CliInfo> {
  const loc = await locate(name, setting, pm);
  if (!loc.path) return { name, path: null, version: null, source: null, error: loc.error };
  try {
    const r = await pm.run({ cmd: loc.path, args: ['--version'], env: await childEnv(settings, pm), timeoutMs: 15000 });
    const version = (r.stdout || r.stderr).trim().split('\n')[0] || null;
    return { name, path: loc.path, version, source: loc.source, error: r.code === 0 ? undefined : `--version endete mit Code ${r.code}` };
  } catch (e) {
    return { name, path: loc.path, version: null, source: loc.source, error: (e as Error).message };
  }
}

export function parseCodexAuth(text: string): AuthInfo {
  if (/logged in using chatgpt/i.test(text)) return { loggedIn: true, method: 'ChatGPT', subscription: true };
  if (/logged in using .*api key/i.test(text)) return { loggedIn: true, method: 'API-Schlüssel', subscription: false, detail: 'Codex ist mit einem API-Schlüssel angemeldet (API-Abrechnung).' };
  if (/logged in/i.test(text) && !/not logged in/i.test(text)) return { loggedIn: true, method: text.trim().split('\n')[0].slice(0, 80), subscription: false };
  return { loggedIn: false, method: 'keine', subscription: false };
}

export function parseClaudeAuth(text: string): AuthInfo {
  try {
    const j = JSON.parse(text);
    const method = String(j.authMethod ?? 'unbekannt');
    const subscription = !!j.loggedIn && method === 'claude.ai' && j.apiProvider === 'firstParty';
    return {
      loggedIn: !!j.loggedIn,
      method: j.loggedIn ? method + (j.subscriptionType ? ` (${j.subscriptionType})` : '') : 'keine',
      subscription,
      detail: j.loggedIn && !subscription ? `Claude Code nutzt "${method}" über "${j.apiProvider}" statt der Abo-Anmeldung.` : undefined,
    };
  } catch {
    return { loggedIn: false, method: 'unbekannt', subscription: false, detail: 'Status konnte nicht gelesen werden.' };
  }
}

export async function checkEnvironment(settings: Settings, pm: ProcessManager): Promise<EnvReport> {
  const [codex, claude, git] = await Promise.all([
    cliInfo('codex', settings.codexPath, settings, pm),
    cliInfo('claude', settings.claudePath, settings, pm),
    cliInfo('git', settings.gitPath, settings, pm),
  ]);
  const env = await childEnv(settings, pm);
  const status = async (cmd: string | null, args: string[]): Promise<string | null> => {
    if (!cmd) return null;
    try {
      const r = await pm.run({ cmd, args, env, timeoutMs: 20000 });
      return r.stdout + r.stderr;
    } catch {
      return null;
    }
  };
  const [codexOut, claudeOut] = await Promise.all([status(codex.path, ['login', 'status']), status(claude.path, ['auth', 'status'])]);
  return {
    clis: { codex, claude, git },
    auth: { codex: codexOut === null ? null : parseCodexAuth(codexOut), claude: claudeOut === null ? null : parseClaudeAuth(claudeOut) },
    conflicts: authConflicts(),
  };
}
