// Projektprofile: Vorgaben, Notizen und Journal je Projektordner – damit lange Arbeit nahtlos weitergeht.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelCatalog, Profile } from '../shared/types';
import { redact } from './proc';
import type { Store } from './store';

const MAX_JOURNAL = 200;
const MAX_CONTEXT_CHARS = 3000; // begrenzt, damit das Profil nicht jedes Mal viel Kontingent kostet

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export function saveProfile(store: Store, input: Partial<Profile>): Profile {
  const all = store.getProfiles();
  const now = Date.now();
  const old = all.find((p) => p.id === input.id);
  const projectDir = text(input.projectDir, 2000) || old?.projectDir || '';
  const p: Profile = {
    id: old?.id ?? randomUUID().slice(0, 8),
    name: text(input.name, 80).trim() || old?.name || path.basename(projectDir) || 'Neues Profil',
    projectDir,
    instructions: text(input.instructions ?? old?.instructions, 20000),
    notes: text(input.notes ?? old?.notes, 50000),
    codexModel: text(input.codexModel ?? old?.codexModel, 80),
    claudeModel: text(input.claudeModel ?? old?.claudeModel, 80),
    codexEffort: text(input.codexEffort ?? old?.codexEffort, 20),
    claudeEffort: text(input.claudeEffort ?? old?.claudeEffort, 20),
    journal: old?.journal ?? [],
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  };
  store.saveProfiles(old ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]);
  return p;
}

export function deleteProfile(store: Store, id: string): void {
  store.saveProfiles(store.getProfiles().filter((p) => p.id !== id));
}

export function addJournal(store: Store, profileId: string | undefined, taskId: string, entry: string): Profile | null {
  const all = store.getProfiles();
  const p = all.find((x) => x.id === profileId);
  if (!p) return null;
  p.journal = [...p.journal, { ts: Date.now(), taskId, text: redact(entry) }].slice(-MAX_JOURNAL);
  p.updatedAt = Date.now();
  store.saveProfiles(all);
  return p;
}

/** Kontext für die Agenten: Vorgaben und Notizen des Nutzers plus die letzten Journal-Einträge. */
export function profileContext(p: Profile | undefined): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.instructions.trim()) parts.push(`Dauerhafte Vorgaben des Nutzers für dieses Projekt:\n${p.instructions.trim()}`);
  if (p.notes.trim()) parts.push(`Notizen des Nutzers zum aktuellen Stand:\n${p.notes.trim()}`);
  const recent = p.journal.slice(-5);
  if (recent.length) parts.push(`Zuletzt erledigt (automatisches Journal, nur zur Orientierung):\n${recent.map((j) => `- ${new Date(j.ts).toISOString().slice(0, 10)}: ${j.text}`).join('\n')}`);
  const out = parts.join('\n\n');
  return out.length > MAX_CONTEXT_CHARS ? `${out.slice(0, MAX_CONTEXT_CHARS)}\n[gekürzt]` : out;
}

/**
 * Modellkatalog. Codex: der Modell-Cache der CLI (keine Zugangsdaten). Claude: die in `claude --help`
 * genannten Aliasse. Ob ein Modell nutzbar ist, entscheidet das Konto.
 */
export function modelCatalog(): ModelCatalog {
  const cat: ModelCatalog = {
    codex: [],
    claude: [
      { slug: 'fable', name: 'Fable' },
      { slug: 'opus', name: 'Opus' },
      { slug: 'sonnet', name: 'Sonnet' },
      { slug: 'haiku', name: 'Haiku' },
    ],
    claudeEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    codexSource: 'nicht gefunden – Modellname bitte von Hand eintragen',
  };
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const m of j.models ?? []) {
      if (m?.visibility !== 'list' || typeof m.slug !== 'string') continue;
      cat.codex.push({
        slug: m.slug,
        name: String(m.display_name ?? m.slug),
        efforts: (m.supported_reasoning_levels ?? []).map((l: any) => String(l?.effort)).filter((e: string) => /^[a-z]+$/.test(e)),
        defaultEffort: String(m.default_reasoning_level ?? ''),
      });
    }
    cat.codexSource = 'Modell-Liste der Codex CLI';
  } catch {
    /* kein Cache vorhanden */
  }
  return cat;
}
