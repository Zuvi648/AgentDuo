// Codex-Adapter: `codex exec --json` mit --output-schema, technisch erzwungenem Lesezugriff
// (-s read-only) und Sitzungsfortsetzung über `codex exec resume`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, Usage } from '../../shared/types';
import { AgentError, classifyError, type ProcessManager } from '../proc';
import type { CliTarget, Planner, PlannerRequest, PlannerResult } from './types';

export interface CodexParsed {
  events: { kind: AgentEvent['kind']; text: string }[];
  threadId?: string;
  usage?: Usage;
  error?: string;
}

/** Wandelt eine JSONL-Zeile von `codex exec --json` in normalisierte Ereignisse um. */
export function parseCodexLine(line: string): CodexParsed {
  const out: CodexParsed = { events: [] };
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return out; // keine JSON-Zeile – ignorieren
  }
  if (!ev || typeof ev !== 'object') return out;
  switch (ev.type) {
    case 'thread.started':
      if (typeof ev.thread_id === 'string') out.threadId = ev.thread_id;
      break;
    case 'turn.completed':
      if (ev.usage) out.usage = { inputTokens: Number(ev.usage.input_tokens) || 0, outputTokens: Number(ev.usage.output_tokens) || 0, cachedTokens: Number(ev.usage.cached_input_tokens) || 0 };
      break;
    case 'turn.failed':
      out.error = String(ev.error?.message ?? 'Codex-Durchlauf fehlgeschlagen');
      out.events.push({ kind: 'error', text: out.error });
      break;
    case 'error':
      out.error = String(ev.message ?? 'Unbekannter Codex-Fehler');
      out.events.push({ kind: 'error', text: out.error });
      break;
    case 'item.started':
    case 'item.completed': {
      const it = ev.item ?? {};
      const done = ev.type === 'item.completed';
      if (it.type === 'agent_message' && done) out.events.push({ kind: 'text', text: String(it.text ?? '') });
      else if (it.type === 'reasoning' && done) out.events.push({ kind: 'info', text: String(it.text ?? '') });
      else if (it.type === 'command_execution') {
        if (!done) out.events.push({ kind: 'tool', text: `$ ${it.command ?? ''}` });
        else if (it.exit_code !== undefined && it.exit_code !== null && it.exit_code !== 0) out.events.push({ kind: 'tool', text: `Befehl endete mit Code ${it.exit_code}` });
      } else if (it.type === 'error' && done) out.events.push({ kind: 'error', text: String(it.message ?? '') });
      else if (!done && typeof it.type === 'string' && it.type !== 'agent_message' && it.type !== 'reasoning') out.events.push({ kind: 'tool', text: it.type });
      break;
    }
  }
  return out;
}

export function codexArgs(req: Pick<PlannerRequest, 'cwd' | 'model' | 'effort' | 'threadId' | 'ephemeral'>, schemaFile: string, outFile: string): string[] {
  const common = ['--json', '--skip-git-repo-check', '--output-schema', schemaFile, '-o', outFile];
  if (req.model) common.push('-m', req.model);
  if (req.effort && /^[a-z]+$/.test(req.effort)) common.push('-c', `model_reasoning_effort="${req.effort}"`);
  if (req.ephemeral) common.push('--ephemeral');
  // `resume` kennt kein -s; die Sandbox wird dort über den Konfigurationsschlüssel erzwungen.
  if (req.threadId) return ['exec', 'resume', req.threadId, '-c', 'sandbox_mode="read-only"', ...common, '-'];
  return ['exec', '-s', 'read-only', '-C', req.cwd, ...common, '-'];
}

export class CodexAdapter implements Planner {
  constructor(
    private pm: ProcessManager,
    private target: CliTarget,
  ) {}

  async run(req: PlannerRequest): Promise<PlannerResult> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duo-codex-'));
    const schemaFile = path.join(tmp, 'schema.json');
    const outFile = path.join(tmp, 'last-message.json');
    fs.writeFileSync(schemaFile, JSON.stringify(req.schema));
    let threadId = req.threadId;
    let usage: Usage | undefined;
    let lastError = '';
    try {
      const r = await this.pm.run({
        cmd: this.target.cmd,
        args: [...(this.target.prefixArgs ?? []), ...codexArgs(req, schemaFile, outFile)],
        cwd: req.cwd,
        env: this.target.env,
        stdin: req.prompt,
        timeoutMs: req.timeoutMs,
        onLine: (line) => {
          const p = parseCodexLine(line);
          if (p.threadId) threadId = p.threadId;
          if (p.usage) usage = p.usage;
          if (p.error) lastError = p.error;
          for (const e of p.events) if (e.text) req.emit(e.kind, e.text);
        },
      });
      if (r.cancelled) throw new AgentError('cancelled', 'Abgebrochen');
      if (r.timedOut) throw new AgentError('timeout', 'Zeitlimit für Codex überschritten');
      if (r.code !== 0 || lastError) {
        const text = `${lastError}\n${r.stderr}`.trim();
        const kind = classifyError(text) ?? 'cli';
        const hint = kind === 'auth' ? 'Codex ist nicht angemeldet. ' : kind === 'limit' ? 'Codex-Nutzungslimit erreicht. ' : '';
        throw new AgentError(kind, `${hint}${(lastError || r.stderr.trim().split('\n').slice(-3).join(' ') || `Exit-Code ${r.code}`).slice(0, 600)}`);
      }
      let raw = '';
      try {
        raw = fs.readFileSync(outFile, 'utf8');
      } catch {
        throw new AgentError('invalid_output', 'Codex hat keine abschließende Antwort geliefert.');
      }
      try {
        return { data: JSON.parse(raw), threadId, usage };
      } catch {
        throw new AgentError('invalid_output', `Codex-Antwort ist kein gültiges JSON: ${raw.slice(0, 200)}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
