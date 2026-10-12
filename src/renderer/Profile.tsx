// Projektprofil (Notizen, Vorgaben, Journal, Projektkarte), Modellauswahl und Nutzungsübersicht.
import { useEffect, useState } from 'react';
import type { ModelCatalog, Profile, Quota, Settings, Task, Usage } from '../shared/types';
import { Mindmap, projectTree } from './Mindmap';
import { PipelineCard } from './Publish';

export interface ModelChoice {
  codexModel: string;
  codexEffort: string;
  claudeModel: string;
  claudeEffort: string;
}

const EFFORT_LABEL: Record<string, string> = { low: 'niedrig (sparsam)', medium: 'mittel', high: 'hoch', xhigh: 'sehr hoch', max: 'maximal', ultra: 'ultra' };
export const fmt = (n: number) => n.toLocaleString('de-DE');

function Select(p: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; fallback: string }) {
  const known = p.options.some((o) => o.value === p.value);
  return (
    <select value={p.value} onChange={(e) => p.onChange(e.target.value)}>
      <option value="">{p.fallback}</option>
      {!known && p.value && <option value={p.value}>{p.value} (eigener Eintrag)</option>}
      {p.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Auswahl von Modell und Denkaufwand für beide Agenten. Leer = Standard der CLI. */
export function ModelPicker(p: { catalog: ModelCatalog | null; value: ModelChoice; onChange: (v: ModelChoice) => void }) {
  const c = p.catalog;
  const set = (k: keyof ModelChoice, v: string) => p.onChange({ ...p.value, [k]: v });
  const codexModel = c?.codex.find((m) => m.slug === p.value.codexModel);
  const codexEfforts = codexModel?.efforts ?? ['low', 'medium', 'high'];
  const eff = (list: string[]) => list.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e }));
  return (
    <div className="grid2 models">
      <div>
        <label className="codex">Codex · Planung und Review</label>
        <div className="row nowrap">
          <Select value={p.value.codexModel} onChange={(v) => p.onChange({ ...p.value, codexModel: v, codexEffort: '' })} fallback="Standardmodell der CLI" options={(c?.codex ?? []).map((m) => ({ value: m.slug, label: m.name }))} />
          <Select value={p.value.codexEffort} onChange={(v) => set('codexEffort', v)} fallback={`Aufwand: Standard${codexModel?.defaultEffort ? ` (${EFFORT_LABEL[codexModel.defaultEffort] ?? codexModel.defaultEffort})` : ''}`} options={eff(codexEfforts)} />
        </div>
      </div>
      <div>
        <label className="claude">Claude Code · Implementierung</label>
        <div className="row nowrap">
          <Select value={p.value.claudeModel} onChange={(v) => set('claudeModel', v)} fallback="Standardmodell der CLI" options={(c?.claude ?? []).map((m) => ({ value: m.slug, label: m.name }))} />
          <Select value={p.value.claudeEffort} onChange={(v) => set('claudeEffort', v)} fallback="Aufwand: Standard" options={eff(c?.claudeEfforts ?? [])} />
        </div>
      </div>
    </div>
  );
}

export function ProfileView(p: { profile: Profile; tasks: Task[]; catalog: ModelCatalog | null; save: (patch: Partial<Profile>) => Promise<void>; remove: () => void; openTask: (id: string) => void; pickDir: () => Promise<string | null>; call: (c: any, ...a: unknown[]) => Promise<unknown>; onTemplate: (prompt: string) => void }) {
  const pr = p.profile;
  const [name, setName] = useState(pr.name);
  const [notes, setNotes] = useState(pr.notes);
  const [instructions, setInstructions] = useState(pr.instructions);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    setName(pr.name);
    setNotes(pr.notes);
    setInstructions(pr.instructions);
  }, [pr.id]);
  const dirty = name !== pr.name || notes !== pr.notes || instructions !== pr.instructions;
  const persist = async () => {
    if (!dirty) return;
    await p.save({ name, notes, instructions });
    setSaved(`gespeichert um ${new Date().toLocaleTimeString('de-DE', { timeStyle: 'short' })}`);
  };
  const contextLen = notes.trim().length + instructions.trim().length;

  return (
    <>
      <div className="card">
        <div className="row">
          <input className="title-input grow" type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={persist} aria-label="Profilname" />
          <span className="muted small">{dirty ? 'ungespeichert' : saved}</span>
          <button className="primary" disabled={!dirty} onClick={persist}>
            Speichern
          </button>
        </div>
        <div className="row small muted" style={{ marginTop: 6 }}>
          <code className="grow ellipsis">{pr.projectDir}</code>
          <button
            className="link"
            onClick={async () => {
              const d = await p.pickDir();
              if (d) await p.save({ projectDir: d });
            }}
          >
            Ordner ändern
          </button>
          <button className="link danger" onClick={p.remove} title="Entfernt nur das Profil; Projektdateien und Aufgaben bleiben erhalten">
            Profil löschen
          </button>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Notizen – wo bin ich stehen geblieben?</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Dein Merkzettel für dieses Projekt: aktueller Stand, nächste Schritte, offene Fragen.</p>
          <textarea rows={11} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={persist} placeholder={'z. B.\n– Login fertig, Passwort-Reset fehlt noch\n– als Nächstes: Export als CSV'} />
        </div>
        <div className="card">
          <h2>Dauerhafte Vorgaben für beide Agenten</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Regeln, die bei jeder Aufgabe gelten sollen: Stil, Architektur, Tabus.</p>
          <textarea rows={11} value={instructions} onChange={(e) => setInstructions(e.target.value)} onBlur={persist} placeholder={'z. B.\n– TypeScript strict, keine neuen Abhängigkeiten\n– Texte der Oberfläche auf Deutsch'} />
        </div>
      </div>
      <p className={`small ${contextLen > 3000 ? 'warn-text' : 'muted'}`} style={{ margin: 0 }}>
        Notizen, Vorgaben und die letzten fünf Journal-Einträge werden jeder Aufgabe mitgegeben – begrenzt auf 3.000 Zeichen, damit es wenig Kontingent kostet. Aktuell {fmt(contextLen)} Zeichen{contextLen > 3000 ? ' – der Rest wird abgeschnitten.' : '.'}
      </p>

      <div className="card">
        <h2>Standardmodelle für dieses Profil</h2>
        <ModelPicker catalog={p.catalog} value={pr} onChange={(v) => void p.save(v)} />
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          Codex-Modelle: {p.catalog?.codexSource ?? '…'}. Welche Modelle tatsächlich nutzbar sind, entscheidet dein Konto; ein nicht freigeschaltetes Modell führt zu einer Fehlermeldung der CLI.
        </p>
      </div>

      <PipelineCard profile={pr} call={p.call} onTemplate={p.onTemplate} />

      <div className="card">
        <h2>Projektkarte</h2>
        {p.tasks.length ? <Mindmap root={projectTree(pr, p.tasks, p.openTask)} /> : <p className="muted">Noch keine Aufgaben in diesem Profil.</p>}
      </div>

      <div className="card">
        <h2>Journal</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Wird automatisch nach jedem Review geführt.</p>
        {pr.journal.length ? (
          <div className="journal">
            {[...pr.journal].reverse().map((j, i) => (
              <div key={i} className="jrow">
                <span className="muted small">{new Date(j.ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</span>
                <span className="grow">{j.text}</span>
                {j.taskId && p.tasks.some((t) => t.id === j.taskId) && (
                  <button className="link" onClick={() => p.openTask(j.taskId!)}>
                    öffnen
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Noch keine Einträge.</p>
        )}
      </div>
    </>
  );
}

function Bar({ value, label, hint }: { value: number; label: string; hint: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="quota">
      <div className="row">
        <b className="grow">{label}</b>
        <span className={pct >= 90 ? 'err-text' : pct >= 70 ? 'warn-text' : ''}>{pct} %</span>
      </div>
      <div className="track">
        <div className={`fill ${pct >= 90 ? 'err' : pct >= 70 ? 'warn' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="muted small">{hint}</div>
    </div>
  );
}

const reset = (s: number) => (s ? `setzt sich zurück am ${new Date(s * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : '');

export function QuotaBars({ quota }: { quota: Quota | null }) {
  if (!quota || (!quota.fiveHour && !quota.sevenDay)) return <p className="muted">Noch keine Daten. Claude Code meldet die Auslastung bei jedem Aufruf.</p>;
  return (
    <>
      <div className="grid2">
        {quota.fiveHour && <Bar value={quota.fiveHour.utilization} label="Claude · 5-Stunden-Fenster" hint={reset(quota.fiveHour.resetsAt)} />}
        {quota.sevenDay && <Bar value={quota.sevenDay.utilization} label="Claude · 7-Tage-Fenster" hint={reset(quota.sevenDay.resetsAt)} />}
      </div>
      <p className="muted small" style={{ margin: '8px 0 0' }}>
        Stand: {new Date(quota.ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}, gemeldet von Claude Code.{quota.usingOverage ? ' Achtung: Zusatznutzung aktiv.' : ''}
      </p>
    </>
  );
}

const sum = (list: (Usage | undefined)[]): Required<Usage> => list.reduce<Required<Usage>>((a, u) => ({ inputTokens: a.inputTokens + (u?.inputTokens ?? 0), outputTokens: a.outputTokens + (u?.outputTokens ?? 0), cachedTokens: a.cachedTokens + (u?.cachedTokens ?? 0) }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

function Stat({ label, u, cls }: { label: string; u: Required<Usage>; cls: string }) {
  return (
    <div className="stat">
      <div className={`small ${cls}`}>{label}</div>
      <div className="big">{fmt(u.inputTokens + u.outputTokens)}</div>
      <div className="muted small">
        {fmt(u.inputTokens)} Eingabe · {fmt(u.outputTokens)} Ausgabe
        {u.inputTokens > 0 && <> · {Math.round((u.cachedTokens / u.inputTokens) * 100)} % aus Cache</>}
      </div>
    </div>
  );
}

export function UsageView(p: { tasks: Task[]; quota: Quota | null; settings: Settings | null; profileName: string; openTask: (id: string) => void; openSettings: () => void }) {
  const real = p.tasks.filter((t) => !t.demo);
  const codex = sum(real.map((t) => t.usage.codex));
  const claude = sum(real.map((t) => t.usage.claude));
  const max = Math.max(1, ...real.map((t) => t.usage.codex.inputTokens + t.usage.codex.outputTokens + t.usage.claude.inputTokens + t.usage.claude.outputTokens));
  return (
    <>
      <div className="card">
        <h2>Kontingent</h2>
        <QuotaBars quota={p.quota} />
        <p className="muted small" style={{ margin: '8px 0 0' }}>Codex meldet in diesem Modus nur Token je Aufruf, keine Kontingent-Auslastung. Kosten werden nicht angezeigt, weil die CLIs dafür im Abo keine verlässlichen Werte liefern.</p>
      </div>
      <div className="card">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>
            Sparmodus <span className={`tag ${p.settings?.economyMode ? 'ok' : 'warn'}`}>{p.settings?.economyMode ? 'aktiv' : 'aus'}</span>
          </h2>
          <button className="link" onClick={p.openSettings}>
            in den Einstellungen ändern
          </button>
        </div>
        <ul className="small muted">
          <li>Beide Agenten bekommen deine Arbeitsregeln: nur relevante Dateien lesen, kleine Patches, keine unnötigen Tests und Builds, kurze Zusammenfassungen.</li>
          <li>Claude Code startet ohne MCP-Server und Skills – im Test rund 12.000 statt 34.000 Tokens Grundlast pro Aufruf.</li>
          <li>Codex führt beim Review die Prüfungen nicht erneut aus und bekommt gekürzte Testausgaben.</li>
          <li>Weitere Hebel: kleineres Modell oder niedrigerer Denkaufwand im Profil bzw. je Aufgabe.</li>
        </ul>
      </div>
      <div className="card">
        <h2>Verbrauch in „{p.profileName}“ ({real.length} Aufgaben)</h2>
        <div className="grid2">
          <Stat label="Codex" u={codex} cls="codex" />
          <Stat label="Claude Code" u={claude} cls="claude" />
        </div>
        {!!real.length && (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Aufgabe</th>
                <th className="num">Codex</th>
                <th className="num">Claude</th>
                <th style={{ width: '28%' }}>Anteil</th>
              </tr>
            </thead>
            <tbody>
              {real.map((t) => {
                const cx = t.usage.codex.inputTokens + t.usage.codex.outputTokens;
                const cl = t.usage.claude.inputTokens + t.usage.claude.outputTokens;
                return (
                  <tr key={t.id} className="click" onClick={() => p.openTask(t.id)}>
                    <td className="ellipsis" style={{ maxWidth: 320 }}>{t.prompt}</td>
                    <td className="num">{fmt(cx)}</td>
                    <td className="num">{fmt(cl)}</td>
                    <td>
                      <div className="track split">
                        <div className="fill cx" style={{ width: `${(cx / max) * 100}%` }} />
                        <div className="fill cl" style={{ width: `${(cl / max) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ margin: '8px 0 0' }}>Token laut CLI, Eingabe einschließlich Cache-Treffern. Tokens sind kein direktes Maß für den Abo-Verbrauch.</p>
      </div>
    </>
  );
}

const STEP: Record<string, string> = { plan: 'Plan', implement: 'Implementierung', review: 'Review' };

export function TaskUsage({ task }: { task: Task }) {
  const log = task.usageLog ?? [];
  if (!log.length) return <p className="muted">Für diese Aufgabe liegen noch keine Verbrauchsdaten vor.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Schritt</th>
          <th>Agent</th>
          <th className="num">Eingabe</th>
          <th className="num">davon Cache</th>
          <th className="num">Ausgabe</th>
        </tr>
      </thead>
      <tbody>
        {log.map((u, i) => (
          <tr key={i}>
            <td>
              {STEP[u.step]}
              {u.round > 0 && ` · Runde ${u.round}`}
            </td>
            <td className={u.agent}>{u.agent === 'codex' ? 'Codex' : 'Claude Code'}</td>
            <td className="num">{fmt(u.inputTokens)}</td>
            <td className="num">{fmt(u.cachedTokens ?? 0)}</td>
            <td className="num">{fmt(u.outputTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
