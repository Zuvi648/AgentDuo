// Prozessverwaltung: startet Kindprozesse ausschließlich mit Argument-Arrays (keine Shell),
// verfolgt sie und beendet beim Abbruch den gesamten Prozessbaum.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { ErrorKind } from '../shared/types';

export class AgentError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}

// Ganze Treffer sind Geheimnisse.
const SECRET_TOKENS: RegExp[] = [
  /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
];
// Gruppe 1 (Schlüsselname) bleibt stehen, der Wert wird entfernt.
const SECRET_ASSIGNMENTS: RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
];

/** Entfernt Geheimnisse aus Text, bevor er protokolliert oder angezeigt wird. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_TOKENS) out = out.replace(re, '[ENTFERNT]');
  for (const re of SECRET_ASSIGNMENTS) out = out.replace(re, '$1[ENTFERNT]');
  return out;
}

/** Ordnet CLI-Fehlertexte verständlichen Kategorien zu. */
export function classifyError(text: string): ErrorKind | null {
  if (/usage limit|rate limit|limit reached|hit your .*limit|quota|too many requests|\b429\b|out of (extra )?usage|try again (at|in) /i.test(text)) return 'limit';
  if (/not logged in|please run .*login|run \/login|unauthorized|\b401\b|invalid api key|authentication (failed|error|required)|token (has )?expired|login required|not authenticated/i.test(text)) return 'auth';
  return null;
}

export interface RunOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  onLine?: (line: string) => void; // stdout, zeilenweise
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

const MAX_CAPTURE = 2_000_000;

export class ProcessManager {
  private children = new Set<ChildProcess>();
  private cancelled = new WeakSet<ChildProcess>();

  get activeCount(): number {
    return this.children.size;
  }

  run(o: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(o.cmd)) {
        reject(new AgentError('not_found', `"${o.cmd}" ist ein .cmd/.bat-Skript. Bitte in den Einstellungen den Pfad zur .exe wählen.`));
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(o.cmd, o.args, {
          cwd: o.cwd,
          env: o.env ?? process.env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32', // eigene Prozessgruppe → Baum beendbar
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new AgentError('not_found', `Start fehlgeschlagen: ${(e as Error).message}`));
        return;
      }
      this.children.add(child);
      let stdout = '';
      let stderr = '';
      let buf = '';
      let timedOut = false;
      const timer = o.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            this.killTree(child);
          }, o.timeoutMs)
        : null;

      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => {
        if (stdout.length < MAX_CAPTURE) stdout += d;
        if (!o.onLine) return;
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line) o.onLine(line);
        }
      });
      child.stderr!.on('data', (d: string) => {
        if (stderr.length < MAX_CAPTURE) stderr += d;
        o.onStderr?.(d);
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(o.stdin ?? '');

      child.on('error', (e: NodeJS.ErrnoException) => {
        if (timer) clearTimeout(timer);
        this.children.delete(child);
        reject(new AgentError('not_found', e.code === 'ENOENT' ? `Programm nicht gefunden: ${o.cmd}` : `Start fehlgeschlagen: ${e.message}`));
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        this.children.delete(child);
        if (buf && o.onLine) o.onLine(buf);
        resolve({ code, stdout, stderr, timedOut, cancelled: this.cancelled.has(child) });
      });
    });
  }

  /** Beendet alle laufenden Kindprozesse samt deren Kindern. */
  killAll(): void {
    for (const c of this.children) {
      this.cancelled.add(c);
      this.killTree(c);
    }
  }

  private killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      return;
    }
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* bereits beendet */
        }
      }
    };
    signal('SIGTERM');
    // Die Gruppe kann den Leiter überleben, daher immer nachfassen.
    setTimeout(() => signal('SIGKILL'), 2000).unref();
  }
}
