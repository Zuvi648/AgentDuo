// Claude-Code-Adapter: Print-Modus (`claude -p`) mit stream-json-Ausgabe.
// Berechtigungen bleiben aktiv (acceptEdits + Allowlist); nicht freigegebene Aktionen
// werden von der CLI abgelehnt und als "denials" an die Orchestrierung gemeldet.
import type { AgentEvent, PermissionDenial, Quota, Usage } from '../../shared/types';
import { AgentError, classifyError, type ProcessManager } from '../proc';
import type { CliTarget, Implementer, ImplementerRequest, ImplementerResult } from './types';

export interface ClaudeParsed {
  events: { kind: AgentEvent['kind']; text: string }[];
  sessionId?: string;
  denials: PermissionDenial[];
  limitHit?: boolean;
  quota?: Quota;
  result?: { isError: boolean; text: string; usage?: Usage };
}

function toolLabel(name: string, input: any): string {
  const detail = input?.command ?? input?.file_path ?? input?.pattern ?? input?.path ?? '';
  return detail ? `${name}: ${String(detail).slice(0, 300)}` : name;
}

/** Wandelt eine stream-json-Zeile von Claude Code in normalisierte Ereignisse um. */
export function parseClaudeLine(line: string): ClaudeParsed {
  const out: ClaudeParsed = { events: [], denials: [] };
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return out;
  }
  if (!ev || typeof ev !== 'object') return out;
  if (typeof ev.session_id === 'string') out.sessionId = ev.session_id;
  switch (ev.type) {
    case 'assistant':
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text) out.events.push({ kind: 'text', text: String(c.text) });
        else if (c.type === 'tool_use') out.events.push({ kind: 'tool', text: toolLabel(String(c.name), c.input) });
      }
      break;
    case 'system':
      if (ev.subtype === 'permission_denied') {
        const d = { tool: String(ev.tool_name ?? 'unbekannt'), detail: String(ev.message ?? '').slice(0, 500) };
        out.denials.push(d);
        out.events.push({ kind: 'error', text: `Freigabe verweigert – ${d.tool}: ${d.detail}` });
      }
      break;
    case 'rate_limit_event': {
      const info = ev.rate_limit_info ?? {};
      const s = info.status;
      const win = (w: any) => (w && typeof w.utilization === 'number' ? { utilization: w.utilization, resetsAt: Number(w.resetsAt) || 0 } : undefined);
      out.quota = { ts: Date.now(), fiveHour: win(info.unifiedWindows?.five_hour), sevenDay: win(info.unifiedWindows?.seven_day), usingOverage: info.isUsingOverage === true };
      if (s && s !== 'allowed' && s !== 'allowed_warning') {
        out.limitHit = true;
        out.events.push({ kind: 'error', text: `Nutzungslimit: ${s}` });
      } else if (info.isUsingOverage === true) {
        // Zusatznutzung wäre kostenpflichtig – niemals stillschweigend weiterlaufen.
        out.limitHit = true;
        out.events.push({ kind: 'error', text: 'Das Abo-Kontingent ist aufgebraucht; die CLI würde kostenpflichtige Zusatznutzung verwenden.' });
      }
      break;
    }
    case 'result': {
      const u = ev.usage;
      out.result = {
        isError: !!ev.is_error || (typeof ev.subtype === 'string' && ev.subtype !== 'success'),
        text: String(ev.result ?? ev.subtype ?? ''),
        usage: u ? { inputTokens: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0), outputTokens: Number(u.output_tokens) || 0, cachedTokens: Number(u.cache_read_input_tokens) || 0 } : undefined,
      };
      for (const d of ev.permission_denials ?? []) out.denials.push({ tool: String(d.tool_name ?? 'unbekannt'), detail: JSON.stringify(d.tool_input ?? {}).slice(0, 500) });
      break;
    }
  }
  return out;
}

/** Teilt "Read Bash(npm test:*) Edit" an Leerzeichen außerhalb von Klammern. */
export function splitTools(s: string): string[] {
  return s.match(/[^\s(]+(?:\([^)]*\))?/g) ?? [];
}

export function claudeArgs(req: Pick<ImplementerRequest, 'model' | 'sessionId' | 'allowedTools' | 'noPersist' | 'effort' | 'economy'>): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
  if (req.allowedTools.length) args.push('--allowedTools', req.allowedTools.join(','));
  args.push('--disallowedTools', 'Bash(git push:*)');
  if (req.economy) args.push('--strict-mcp-config', '--disable-slash-commands');
  if (req.effort && /^[a-z]+$/.test(req.effort)) args.push('--effort', req.effort);
  if (req.model) args.push('--model', req.model);
  if (req.sessionId) args.push('--resume', req.sessionId);
  if (req.noPersist) args.push('--no-session-persistence');
  return args;
}

export class ClaudeAdapter implements Implementer {
  constructor(
    private pm: ProcessManager,
    private target: CliTarget,
  ) {}

  async run(req: ImplementerRequest): Promise<ImplementerResult> {
    let sessionId = req.sessionId;
    let result: ClaudeParsed['result'];
    let limitHit = false;
    const liveDenials: PermissionDenial[] = [];
    let resultDenials: PermissionDenial[] = [];
    let lastText = '';
    const r = await this.pm.run({
      cmd: this.target.cmd,
      args: [...(this.target.prefixArgs ?? []), ...claudeArgs(req)],
      cwd: req.cwd,
      env: this.target.env,
      stdin: req.prompt,
      timeoutMs: req.timeoutMs,
      onLine: (line) => {
        const p = parseClaudeLine(line);
        if (p.sessionId) sessionId = p.sessionId;
        if (p.result) result = p.result;
        if (p.limitHit) limitHit = true;
        if (p.quota) req.onQuota?.(p.quota);
        // Denials kommen als Ereignis und nochmals im Ergebnis – nur eine Quelle verwenden.
        if (p.result) resultDenials = p.denials;
        else liveDenials.push(...p.denials);
        for (const e of p.events) {
          if (e.kind === 'text') lastText = e.text;
          req.emit(e.kind, e.text);
        }
      },
    });
    if (r.cancelled) throw new AgentError('cancelled', 'Abgebrochen');
    if (r.timedOut) throw new AgentError('timeout', 'Zeitlimit für Claude Code überschritten');
    if (!result || result.isError || r.code !== 0) {
      const text = `${result?.text ?? ''}\n${r.stderr}`.trim();
      const kind = limitHit ? 'limit' : (classifyError(text) ?? 'cli');
      const hint = kind === 'auth' ? 'Claude Code ist nicht angemeldet. ' : kind === 'limit' ? 'Claude-Nutzungslimit erreicht. ' : '';
      throw new AgentError(kind, `${hint}${(result?.text || r.stderr.trim().split('\n').slice(-3).join(' ') || `Exit-Code ${r.code}, keine Ergebnis-Meldung`).slice(0, 600)}`);
    }
    return { summary: result.text || lastText, sessionId, denials: liveDenials.length ? liveDenials : resultDenials, usage: result.usage };
  }
}
