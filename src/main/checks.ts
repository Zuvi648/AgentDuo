// Führt die im (vom Nutzer bestätigten) Plan genannten Prüfbefehle aus – ohne Shell.
import type { CheckResult, PlanCheck } from '../shared/types';
import { AgentError, redact, type ProcessManager } from './proc';

const MAX_OUTPUT = 20_000;

/** Zerlegt einen Befehl in Argumente. Shell-Syntax wird abgelehnt statt interpretiert. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) tokens.push(cur);
      cur = '';
      has = false;
    } else if ('|&;<>`$'.includes(ch)) {
      throw new Error(`Shell-Syntax "${ch}" wird nicht unterstützt`);
    } else cur += ch;
  }
  if (quote) throw new Error('Anführungszeichen nicht geschlossen');
  if (has || cur) tokens.push(cur);
  if (!tokens.length) throw new Error('Leerer Befehl');
  return tokens;
}

export async function runChecks(pm: ProcessManager, checks: PlanCheck[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, log: (text: string) => void): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    const started = Date.now();
    let argv: string[];
    try {
      argv = tokenize(c.command);
    } catch (e) {
      results.push({ name: c.name, command: c.command, exitCode: null, output: '', durationMs: 0, error: (e as Error).message });
      log(`Prüfung "${c.name}" übersprungen: ${(e as Error).message}`);
      continue;
    }
    log(`Prüfung "${c.name}": ${c.command}`);
    try {
      const r = await pm.run({ cmd: argv[0], args: argv.slice(1), cwd, env, timeoutMs });
      if (r.cancelled) throw new AgentError('cancelled', 'Abgebrochen');
      const output = redact((r.stdout + (r.stderr ? `\n${r.stderr}` : '')).slice(-MAX_OUTPUT));
      results.push({ name: c.name, command: c.command, exitCode: r.code, output, durationMs: Date.now() - started, error: r.timedOut ? 'Zeitlimit überschritten' : undefined });
      log(`→ Exit-Code ${r.code}${r.timedOut ? ' (Zeitlimit)' : ''}`);
    } catch (e) {
      if (e instanceof AgentError && e.kind === 'cancelled') throw e;
      results.push({ name: c.name, command: c.command, exitCode: null, output: '', durationMs: Date.now() - started, error: (e as Error).message });
      log(`→ nicht ausführbar: ${(e as Error).message}`);
    }
  }
  return results;
}
