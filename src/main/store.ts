// Lokale Persistenz: Einstellungen, Aufgaben und (bereinigte) Protokolle als JSON-Dateien.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type AgentEvent, type Profile, type Quota, type Settings, type Task } from '../shared/types';
import { redact } from './proc';

const MAX_LOG_BYTES = 4_000_000;

export class Store {
  private tasksDir: string;
  private logsDir: string;

  constructor(public readonly dir: string) {
    this.tasksDir = path.join(dir, 'tasks');
    this.logsDir = path.join(dir, 'logs');
    fs.mkdirSync(this.tasksDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  private writeAtomic(file: string, data: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  }

  getSettings(): Settings {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(path.join(this.dir, 'settings.json'), 'utf8')) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  setSettings(s: Settings): Settings {
    const clean: Settings = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = (s as any)?.[k];
      if (typeof v === typeof DEFAULT_SETTINGS[k]) (clean as any)[k] = v;
    }
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));
    clean.planTimeoutMin = clamp(clean.planTimeoutMin, 1, 240);
    clean.implementTimeoutMin = clamp(clean.implementTimeoutMin, 1, 480);
    clean.reviewTimeoutMin = clamp(clean.reviewTimeoutMin, 1, 240);
    clean.checkTimeoutMin = clamp(clean.checkTimeoutMin, 1, 240);
    clean.maxFixRounds = Math.min(10, Math.max(0, Math.round(clean.maxFixRounds) || 0));
    this.writeAtomic(path.join(this.dir, 'settings.json'), JSON.stringify(clean, null, 2));
    return clean;
  }

  private readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  getProfiles(): Profile[] {
    return this.readJson<Profile[]>('profiles.json', []);
  }

  saveProfiles(p: Profile[]): void {
    this.writeAtomic(path.join(this.dir, 'profiles.json'), JSON.stringify(p, null, 2));
  }

  getQuota(): Quota | null {
    return this.readJson<Quota | null>('quota.json', null);
  }

  saveQuota(q: Quota): void {
    this.writeAtomic(path.join(this.dir, 'quota.json'), JSON.stringify(q));
  }

  saveTask(t: Task): void {
    t.updatedAt = Date.now();
    this.writeAtomic(path.join(this.tasksDir, `${t.id}.json`), JSON.stringify(t, null, 2));
  }

  loadTasks(): Task[] {
    const out: Task[] = [];
    for (const f of fs.readdirSync(this.tasksDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.tasksDir, f), 'utf8')));
      } catch {
        /* beschädigte Datei überspringen */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  deleteTask(id: string): void {
    fs.rmSync(path.join(this.tasksDir, `${id}.json`), { force: true });
    fs.rmSync(path.join(this.logsDir, `${id}.jsonl`), { force: true });
  }

  appendLog(e: AgentEvent): void {
    const file = path.join(this.logsDir, `${e.taskId}.jsonl`);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) return;
      fs.appendFileSync(file, JSON.stringify({ ...e, text: redact(e.text) }) + '\n', 'utf8');
    } catch {
      /* Protokollfehler dürfen den Lauf nicht stören */
    }
  }

  readLog(id: string): AgentEvent[] {
    try {
      return fs
        .readFileSync(path.join(this.logsDir, `${id}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
