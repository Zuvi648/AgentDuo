import { useEffect, useState } from 'react';
import type { ConnTest, EnvReport, Settings } from '../shared/types';

type Tests = { codex?: ConnTest; claude?: ConnTest };
const msg = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function SetupView(p: { env: EnvReport | null; busy: boolean; tests: Tests; setTests: (f: (t: Tests) => Tests) => void; refresh: () => void; settings: Settings | null }) {
  const [log, setLog] = useState<string[]>([]);
  const [working, setWorking] = useState('');
  useEffect(() => window.api.on('setup:log', (line: string) => setLog((l) => [...l, line].slice(-400))), []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setWorking(key);
    try {
      await fn();
    } catch (e) {
      setLog((l) => [...l, `Fehler: ${msg(e)}`]);
    } finally {
      setWorking('');
    }
  };

  const section = (which: 'codex' | 'claude', title: string, role: string) => {
    const cli = p.env?.clis[which];
    const auth = p.env?.auth[which];
    const test = p.tests[which];
    return (
      <div className="card">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>
            {title} <span className="muted small">· {role}</span>
          </h2>
          {!cli?.path && (
            <button className="primary" disabled={!!working} onClick={() => run(`install-${which}`, async () => { await window.api.invoke('env:install', which); p.refresh(); })}>
              {working === `install-${which}` ? 'Installiere…' : 'Über offiziellen Weg installieren'}
            </button>
          )}
          <button disabled={!cli?.path || !!working} onClick={() => run(`login-${which}`, () => window.api.invoke('env:login', which))} title="Öffnet ein Terminal mit dem offiziellen Anmeldebefehl der CLI">
            Anmelden…
          </button>
          <button
            disabled={!cli?.path || !!working}
            onClick={() =>
              run(`test-${which}`, async () => {
                const r = await window.api.invoke<ConnTest>('env:test', which);
                p.setTests((t) => ({ ...t, [which]: r }));
              })
            }
          >
            {working === `test-${which}` ? 'Teste…' : 'Verbindung testen'}
          </button>
        </div>
        <div className="kv" style={{ marginTop: 8 }}>
          <b>Pfad</b>
          <span>{cli?.path ? <code>{cli.path}</code> : <span style={{ color: 'var(--err)' }}>{cli?.error ?? 'wird geprüft…'}</span>}</span>
          <b>Quelle</b>
          <span>{cli?.source ?? '–'}</span>
          <b>Version</b>
          <span>{cli?.version ?? '–'}</span>
          <b>Anmeldung</b>
          <span>
            {!auth ? '–' : auth.loggedIn ? <span className={`tag ${auth.subscription ? 'ok' : 'warn'}`}>{auth.method}</span> : <span className="tag err">nicht angemeldet</span>}
            {auth?.detail && <span style={{ color: 'var(--warn)' }}> {auth.detail}</span>}
          </span>
          <b>Echter Test</b>
          <span>{test ? <span style={{ color: test.ok ? 'var(--ok)' : 'var(--err)' }}>{test.ok ? '✓' : '✗'} {test.message}</span> : <span className="muted">noch nicht ausgeführt (sendet eine sehr kleine Anfrage)</span>}</span>
        </div>
      </div>
    );
  };

  const git = p.env?.clis.git;
  return (
    <>
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          Einrichtung und Verbindungen
        </h2>
        <button disabled={p.busy} onClick={p.refresh}>
          {p.busy ? 'Prüfe…' : 'Erneut prüfen'}
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Agent Duo verwendet die vorhandenen Anmeldungen der CLIs. Es liest keine Token-Dateien und speichert keine Passwörter. Nach dem Anmelden im Terminal bitte „Erneut prüfen“ wählen.
      </p>
      {section('codex', 'Codex CLI', 'Planung, Review')}
      {section('claude', 'Claude Code', 'Implementierung')}
      <div className="card">
        <h2 style={{ margin: 0 }}>Git</h2>
        <div className="kv" style={{ marginTop: 8 }}>
          <b>Pfad</b>
          <span>{git?.path ? <code>{git.path}</code> : <span style={{ color: 'var(--err)' }}>{git?.error ?? 'wird geprüft…'} – bitte Git installieren (macOS: „xcode-select --install“, Windows: git-scm.com).</span>}</span>
          <b>Version</b>
          <span>{git?.version ?? '–'}</span>
        </div>
      </div>
      {!!log.length && (
        <div className="card">
          <h2>Protokoll</h2>
          <pre className="wrap">{log.join('\n')}</pre>
        </div>
      )}
    </>
  );
}

export function SettingsView(p: { settings: Settings; onSave: (s: Settings) => void }) {
  const [s, setS] = useState<Settings>(p.settings);
  useEffect(() => setS(p.settings), [p.settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(p.settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));

  const pathField = (k: 'codexPath' | 'claudePath' | 'gitPath', label: string) => (
    <div>
      <label>{label}</label>
      <div className="row">
        <input className="grow" style={{ width: 'auto' }} type="text" placeholder="automatisch suchen" value={s[k]} onChange={(e) => set(k, e.target.value)} />
        <button
          onClick={async () => {
            const f = await window.api.invoke<string | null>('dialog:pickFile');
            if (f) set(k, f);
          }}
        >
          Wählen…
        </button>
      </div>
    </div>
  );
  const num = (k: 'planTimeoutMin' | 'implementTimeoutMin' | 'reviewTimeoutMin' | 'checkTimeoutMin' | 'maxFixRounds', label: string) => (
    <div>
      <label>{label}</label>
      <input type="number" min={k === 'maxFixRounds' ? 0 : 1} value={s[k]} onChange={(e) => set(k, Number(e.target.value))} />
    </div>
  );
  const check = (k: 'useWorktree' | 'confirmPlan' | 'pauseOnDenial' | 'allowApiKeyAuth' | 'economyMode', label: string) => (
    <label className="row" style={{ color: 'var(--text)', fontSize: 13 }}>
      <input type="checkbox" checked={s[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  );

  return (
    <div className="card">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          Einstellungen
        </h2>
        <button className="primary" disabled={!dirty} onClick={() => p.onSave(s)}>
          Speichern
        </button>
      </div>
      <h3>Kontingent sparen</h3>
      {check('economyMode', 'Sparmodus: Arbeitsregeln an beide Agenten, Claude Code ohne MCP-Server und Skills starten (empfohlen)')}
      <p className="muted small" style={{ margin: 0 }}>Modelle und Denkaufwand stellst du im Profil oder direkt bei der Aufgabe ein.</p>
      <h3>CLI-Pfade</h3>
      <p className="muted small" style={{ margin: 0 }}>Leer lassen, um im PATH der Login-Shell und an den üblichen Installationsorten zu suchen.</p>
      {pathField('codexPath', 'Codex CLI')}
      {pathField('claudePath', 'Claude Code')}
      {pathField('gitPath', 'Git')}
      <h3>Zeitlimits (Minuten) und Runden</h3>
      <div className="grid2">
        {num('planTimeoutMin', 'Planung (Codex)')}
        {num('implementTimeoutMin', 'Implementierung je Runde (Claude)')}
        {num('reviewTimeoutMin', 'Review (Codex)')}
        {num('checkTimeoutMin', 'Je Prüfbefehl')}
        {num('maxFixRounds', 'Maximale Korrekturrunden')}
      </div>
      <h3>Ablauf und Projektschutz</h3>
      {check('confirmPlan', 'Plan und Prüfbefehle vor der Implementierung bestätigen (empfohlen)')}
      {check('useWorktree', 'In separatem Git-Worktree arbeiten (empfohlen)')}
      {check('pauseOnDenial', 'Anhalten, wenn Claude Code eine Aktion nicht freigegeben wurde (sonst wird es nur dem Review gemeldet)')}
      <label>Für Claude Code freigegebene Werkzeuge (--allowedTools, durch Leerzeichen getrennt)</label>
      <input className="mono" type="text" value={s.claudeAllowedTools} onChange={(e) => set('claudeAllowedTools', e.target.value)} />
      <p className="muted small" style={{ margin: '4px 0 0' }}>Alles andere lehnt die CLI ab; der Ablauf hält dann an und fragt dich. Globale Bypass-Optionen werden nie verwendet.</p>
      <h3>Abrechnung</h3>
      {check('allowApiKeyAuth', 'Anmeldung per API-Schlüssel bzw. Drittanbieter erlauben (kann Kosten nach Verbrauch verursachen)')}
      <p className="muted small" style={{ margin: 0 }}>Standardmäßig aus: Es wird nur die Abo-Anmeldung verwendet, API-Variablen werden nicht an die CLIs weitergegeben.</p>
    </div>
  );
}
