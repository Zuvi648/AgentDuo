// Veröffentlichen in drei einfachen Schritten und die Deploy-Pipeline eines Projekts.
import { useCallback, useEffect, useState } from 'react';
import type { PipelineInfo, Profile, PublishState, Task } from '../shared/types';

type Call = (channel: any, ...args: unknown[]) => Promise<unknown>;

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <rect x="64" y="64" width="896" height="896" rx="208" fill="#12141a" />
      <circle cx="400" cy="512" r="196" fill="none" stroke="#9d8cff" strokeWidth="72" />
      <circle cx="624" cy="512" r="196" fill="none" stroke="#ee9a72" strokeWidth="72" />
    </svg>
  );
}

function StepCard(p: { n: number; title: string; done: boolean; locked?: boolean; children: React.ReactNode }) {
  return (
    <div className={`pstep ${p.done ? 'done' : ''} ${p.locked ? 'locked' : ''}`}>
      <div className="num">{p.done ? '✓' : p.n}</div>
      <div className="grow">
        <div className="ptitle">{p.title}</div>
        {p.children}
      </div>
    </div>
  );
}

export function PublishPanel({ task, call, openProfile }: { task: Task; call: Call; openProfile: () => void }) {
  const [s, setS] = useState<PublishState | null>(null);
  const [msg, setMsg] = useState(task.plan?.goal.slice(0, 200) ?? task.prompt.slice(0, 200));
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const refresh = useCallback(async () => setS(((await call('publish:state', task.id)) as PublishState | undefined) ?? null), [call, task.id]);
  useEffect(() => {
    void refresh();
  }, [refresh, task.updatedAt]);

  const run = async (key: string, fn: () => Promise<unknown>, okNote = '') => {
    setBusy(key);
    setNote('');
    const r = await fn();
    await refresh();
    setBusy('');
    if (r !== undefined && r !== null && r !== false) setNote(okNote);
    return r;
  };

  if (task.demo) return <p className="muted">Im Demo-Modus gibt es nichts zu veröffentlichen.</p>;
  if (!task.workDir) return <p className="muted">Sobald Claude etwas geändert hat, kannst du es hier in drei Schritten veröffentlichen.</p>;
  if (task.status === 'running') return <p className="muted">Die Aufgabe läuft noch. Veröffentlichen geht, sobald sie fertig ist.</p>;
  if (!s) return <p className="muted">Lade Stand…</p>;

  const saved = s.uncommitted === 0;
  const n3 = s.inPlace ? 2 : 3;
  return (
    <div className="psteps">
      {task.phase !== 'done' && <div className="banner warn">Diese Aufgabe wurde noch nicht von Codex akzeptiert. Du kannst trotzdem veröffentlichen – prüfe den Diff vorher selbst.</div>}
      <StepCard n={1} title="Änderungen sichern" done={saved}>
        <p className="muted small">Speichert den aktuellen Stand als Version auf deinem Rechner (ein „Commit“). Es geht noch nichts ins Internet.</p>
        {!saved && (
          <div className="row nowrap">
            <input className="grow" type="text" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Kurze Beschreibung, z. B. „Kontaktformular hinzugefügt“" />
            <button className="primary" disabled={!!busy || !msg.trim()} onClick={() => run('commit', () => call('publish:commit', task.id, msg))}>
              {busy === 'commit' ? 'Sichere…' : `${s.uncommitted} Datei(en) sichern`}
            </button>
          </div>
        )}
      </StepCard>

      {!s.inPlace && (
        <StepCard n={2} title="In dein Projekt übernehmen" done={s.merged} locked={!saved}>
          <p className="muted small">
            Die Agenten haben in einer getrennten Kopie gearbeitet (Branch <code>{s.workBranch}</code>). Dieser Schritt holt die Änderungen in dein Projekt{s.projectBranch && <> (Branch <code>{s.projectBranch}</code>)</>}. Bei Konflikten passiert nichts.
          </p>
          {saved && !s.merged && (
            <div className="row">
              <button className="primary" disabled={!!busy} onClick={() => run('merge', () => call('publish:merge', task.id))}>
                {busy === 'merge' ? 'Übernehme…' : 'Übernehmen'}
              </button>
              {s.remote && (
                <button
                  disabled={!!busy}
                  title="Lädt nur den Arbeits-Branch hoch, damit du die Änderung auf GitHub erst prüfen und dann zusammenführen kannst"
                  onClick={async () => {
                    const branch = await run('pr', () => call('publish:push', task.id, 'pr'), 'Arbeits-Branch hochgeladen.');
                    if (typeof branch === 'string' && s.webUrl) await call('publish:open', task.projectDir, 'pr', branch);
                  }}
                >
                  {busy === 'pr' ? 'Lade hoch…' : 'Lieber als Pull Request hochladen'}
                </button>
              )}
            </div>
          )}
        </StepCard>
      )}

      <StepCard n={n3} title="Auf GitHub hochladen" done={s.pushed} locked={!s.merged}>
        {!s.remote ? (
          <p className="muted small">
            Dein Projekt ist noch nicht mit GitHub verbunden.{' '}
            <button className="link" onClick={openProfile}>
              Unter „Projekt &amp; Notizen“ verbinden
            </button>
          </p>
        ) : (
          <>
            <p className="muted small">
              Lädt dein Projekt nach <code>{s.remote}</code> hoch (ein „Push“).{' '}
              {s.workflows.length ? (
                <>
                  Danach startet die Pipeline automatisch: <code>{s.workflows.join(', ')}</code>.
                </>
              ) : (
                <>
                  Es ist noch keine Pipeline eingerichtet – es wird nur hochgeladen, nichts veröffentlicht.{' '}
                  <button className="link" onClick={openProfile}>
                    Pipeline einrichten
                  </button>
                </>
              )}
            </p>
            <div className="row">
              {s.merged && !s.pushed && (
                <button className="primary" disabled={!!busy} onClick={() => run('push', () => call('publish:push', task.id, 'project'), 'Hochgeladen.')}>
                  {busy === 'push' ? 'Lade hoch…' : 'Hochladen'}
                </button>
              )}
              {s.webUrl && s.pushed && !!s.workflows.length && (
                <button className="primary" onClick={() => call('publish:open', task.projectDir, 'actions')}>
                  Pipeline auf GitHub ansehen
                </button>
              )}
              {s.webUrl && <button onClick={() => call('publish:open', task.projectDir, 'repo')}>Repository öffnen</button>}
            </div>
          </>
        )}
      </StepCard>
      {note && <p className="ok-text small">{note}</p>}
      {s.pushed && <div className="banner info">Fertig – dein Projekt liegt aktuell auf GitHub.{s.workflows.length ? ' Ob das Veröffentlichen geklappt hat, zeigt dir die Pipeline auf GitHub (grüner Haken).' : ''}</div>}
    </div>
  );
}

const TEMPLATES: { title: string; hint: string; prompt: (branch: string) => string }[] = [
  {
    title: 'Webseite veröffentlichen',
    hint: 'Stellt deine Seite bei jedem Hochladen kostenlos über GitHub Pages online.',
    prompt: (b) =>
      `Richte eine GitHub-Actions-Pipeline ein, die diese Webseite bei jedem Push auf den Branch "${b}" automatisch auf GitHub Pages veröffentlicht. Lege dafür .github/workflows/deploy.yml an und verwende die offiziellen Actions (actions/checkout, actions/configure-pages, actions/upload-pages-artifact, actions/deploy-pages). Erkenne selbst, ob ein Build-Schritt nötig ist (z. B. npm run build) und welcher Ordner veröffentlicht wird. Nenne in der Zusammenfassung, was ich auf GitHub einmalig einstellen muss (Settings → Pages → Source: GitHub Actions).`,
  },
  {
    title: 'Tests automatisch ausführen',
    hint: 'Prüft bei jedem Hochladen, ob noch alles funktioniert.',
    prompt: () => 'Richte eine GitHub-Actions-Pipeline ein (.github/workflows/ci.yml), die bei jedem Push und bei jedem Pull Request die Tests dieses Projekts ausführt. Erkenne die passenden Befehle aus dem Projekt. Es sollen keine Secrets nötig sein.',
  },
  {
    title: 'Eigene Pipeline',
    hint: 'Beschreibe selbst, was nach dem Hochladen passieren soll.',
    prompt: (b) => `Richte eine GitHub-Actions-Pipeline ein, die bei jedem Push auf den Branch "${b}" Folgendes tut: `,
  },
];

export function PipelineCard({ profile, call, onTemplate }: { profile: Profile; call: Call; onTemplate: (prompt: string) => void }) {
  const [info, setInfo] = useState<PipelineInfo | null>(null);
  const [url, setUrl] = useState('');
  const refresh = useCallback(async () => setInfo(((await call('pipeline:info', profile.id)) as PipelineInfo | undefined) ?? null), [call, profile.id]);
  useEffect(() => {
    void refresh();
  }, [refresh, profile.projectDir]);

  return (
    <div className="card">
      <h2>GitHub und Deploy-Pipeline</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Eine Pipeline ist eine kleine Datei in deinem Projekt. Sie sagt GitHub, was nach jedem Hochladen automatisch passieren soll – zum Beispiel Tests ausführen oder deine Webseite online stellen.
      </p>
      {!info ? (
        <p className="muted">Prüfe Projekt…</p>
      ) : !info.isRepo ? (
        <div className="banner warn">Der Projektordner ist noch kein Git-Repository.</div>
      ) : (
        <>
          <div className="kv" style={{ gridTemplateColumns: '150px 1fr' }}>
            <b>Verbunden mit GitHub</b>
            <span>
              {info.remote ? (
                <>
                  <span className="tag ok">ja</span> <code>{info.remote}</code>{' '}
                  {info.webUrl && (
                    <button className="link" onClick={() => call('publish:open', profile.projectDir, 'repo')}>
                      öffnen
                    </button>
                  )}
                </>
              ) : (
                <span className="tag warn">noch nicht</span>
              )}
            </span>
            <b>Pipelines im Projekt</b>
            <span>{info.workflows.length ? info.workflows.map((w) => <code key={w} style={{ marginRight: 8 }}>{w}</code>) : <span className="muted">keine</span>}</span>
          </div>
          {!info.remote && (
            <div className="banner info" style={{ marginTop: 10 }}>
              <b>So verbindest du dein Projekt:</b> Lege auf github.com ein neues, leeres Repository an und füge seine Adresse hier ein.
              <div className="row nowrap" style={{ marginTop: 8 }}>
                <input className="grow" type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/dein-name/dein-projekt.git" />
                <button
                  className="primary"
                  disabled={!url.trim()}
                  onClick={async () => {
                    await call('publish:setRemote', profile.id, url);
                    await refresh();
                  }}
                >
                  Verbinden
                </button>
              </div>
            </div>
          )}
          <h3>Pipeline von den Agenten bauen lassen</h3>
          <div className="templates">
            {TEMPLATES.map((t) => (
              <button key={t.title} className="template" onClick={() => onTemplate(t.prompt(info.branch || 'main'))}>
                <b>{t.title}</b>
                <span className="muted small">{t.hint}</span>
              </button>
            ))}
          </div>
          <p className="muted small" style={{ margin: '8px 0 0' }}>
            Ein Klick füllt eine neue Aufgabe vor. Codex plant die Pipeline, Claude schreibt sie, und im Reiter „Veröffentlichen“ lädst du sie hoch.
            {info.webUrl && info.workflows.length > 0 && (
              <>
                {' '}
                <button className="link" onClick={() => call('publish:open', profile.projectDir, 'actions')}>
                  Bisherige Läufe auf GitHub ansehen
                </button>
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}
