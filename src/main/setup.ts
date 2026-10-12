// Einrichtung: Installation über die offiziellen Wege, Anmeldung über die offiziellen
// CLI-Flüsse (im Terminal) und ein kleiner echter Verbindungstest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConnTest, Settings } from '../shared/types';
import { ClaudeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import { PING_SCHEMA } from './contracts';
import { childEnv } from './env';
import { AgentError, redact, type ProcessManager } from './proc';

const isWin = process.platform === 'win32';

// Feste, offizielle Installationsbefehle (geprüft am 12.10.2026) – es fließt keine Nutzereingabe ein.
// Claude Code: https://code.claude.com/docs/en/setup · Codex: https://learn.chatgpt.com/docs/codex/cli
const CLAUDE_INSTALL_UNIX = 'curl -fsSL https://claude.ai/install.sh | bash';
const CLAUDE_INSTALL_WIN = 'irm https://claude.ai/install.ps1 | iex';
const CODEX_INSTALL_UNIX = 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';
export const CODEX_DOCS = 'https://learn.chatgpt.com/docs/codex/cli';

export async function installCli(which: 'codex' | 'claude', settings: Settings, pm: ProcessManager, log: (line: string) => void): Promise<ConnTest> {
  const env = await childEnv(settings, pm);
  let cmd: string;
  let args: string[];
  if (which === 'claude') {
    if (isWin) [cmd, args] = ['powershell.exe', ['-NoProfile', '-Command', CLAUDE_INSTALL_WIN]];
    else [cmd, args] = ['/bin/bash', ['-c', CLAUDE_INSTALL_UNIX]];
  } else if (isWin) {
    return { ok: false, message: `Codex bitte unter Windows nach der offiziellen Anleitung installieren: ${CODEX_DOCS}` };
  } else [cmd, args] = ['/bin/sh', ['-c', CODEX_INSTALL_UNIX]];
  log(`> ${[cmd, ...args].join(' ')}`);
  try {
    const r = await pm.run({ cmd, args, env, timeoutMs: 15 * 60_000, onLine: (l) => log(redact(l)), onStderr: (d) => log(redact(d.trimEnd())) });
    const ok = r.code === 0;
    log(ok ? 'Installation abgeschlossen.' : `Installation fehlgeschlagen (Exit-Code ${r.code}).`);
    return { ok, message: ok ? 'Installation abgeschlossen.' : `Installation fehlgeschlagen (Exit-Code ${r.code}). Details im Protokoll.` };
  } catch (e) {
    log(`Fehler: ${(e as Error).message}`);
    return { ok: false, message: (e as Error).message };
  }
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Öffnet ein Terminalfenster und führt dort einen Befehl interaktiv aus. */
export function openTerminal(argv: string[], cwd: string): void {
  if (isWin) {
    spawn('cmd.exe', ['/c', 'start', 'Agent Duo', '/d', cwd, 'cmd.exe', '/k', ...argv], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  // Ein .command-Skript ist auf macOS der einfachste Weg in Terminal.app; alle Werte werden einzeln gequotet.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duo-term-'));
  const file = path.join(dir, 'agent-duo.command');
  fs.writeFileSync(file, `#!/bin/bash\ncd ${shQuote(cwd)} || exit 1\n${argv.map(shQuote).join(' ')}\necho\necho "Fertig – dieses Fenster kann geschlossen werden."\n`, { mode: 0o700 });
  if (process.platform === 'darwin') spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
  else spawn('x-terminal-emulator', ['-e', file], { detached: true, stdio: 'ignore' }).unref();
}

/** Offizieller Anmeldefluss der jeweiligen CLI (öffnet den Browser-Login der CLI). */
export function loginArgs(which: 'codex' | 'claude', cliPath: string): string[] {
  return which === 'codex' ? [cliPath, 'login'] : [cliPath, 'auth', 'login'];
}

/** Kleiner echter Test: eine minimale Anfrage über denselben Weg wie im Ablauf. */
export async function testConnection(which: 'codex' | 'claude', cliPath: string, settings: Settings, pm: ProcessManager): Promise<ConnTest> {
  const env = await childEnv(settings, pm);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duo-test-'));
  try {
    if (which === 'codex') {
      const r = await new CodexAdapter(pm, { cmd: cliPath, env }).run({
        cwd,
        prompt: 'Verbindungstest. Führe keine Befehle aus. Antworte mit {"ok": true}.',
        schema: PING_SCHEMA,
        model: settings.codexModel,
        timeoutMs: 120_000,
        ephemeral: true,
        emit: () => {},
      });
      return (r.data as any)?.ok === true ? { ok: true, message: 'Codex antwortet.' } : { ok: false, message: 'Codex hat unerwartet geantwortet.' };
    }
    const r = await new ClaudeAdapter(pm, { cmd: cliPath, env }).run({
      cwd,
      prompt: 'Verbindungstest. Verwende keine Werkzeuge. Antworte nur mit dem Wort: pong',
      model: settings.claudeModel,
      timeoutMs: 120_000,
      allowedTools: [],
      noPersist: true,
      emit: () => {},
    });
    return /pong/i.test(r.summary) ? { ok: true, message: 'Claude Code antwortet.' } : { ok: false, message: `Unerwartete Antwort: ${r.summary.slice(0, 120)}` };
  } catch (e) {
    const err = e as AgentError;
    return { ok: false, message: redact(err.message) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
