import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AnswerMode, Api, ConnTest, EnvReport, GitState, ModelCatalog, Plan, Profile, Quota, Settings, Task } from '../shared/types';
import { SetupView, SettingsView } from './Config';
import { Mindmap, taskTree } from './Mindmap';
import { Logo, PublishPanel } from './Publish';
import { ModelPicker, ProfileView, TaskUsage, UsageView, type ModelChoice } from './Profile';

declare global {
  interface Window {
    api: Api;
  }
}
const api = () => window.api;

export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const STEPS: { key: string; label: string }[] = [
  { key: 'plan', label: 'Codex-Plan' },
  { key: 'await_plan', label: 'Plan bestätigen' },
  { key: 'implement', label: 'Claude-Implementierung' },
  { key: 'test', label: 'Tests' },
  { key: 'review', label: 'Codex-Review' },
  { key: 'done', label: 'Ergebnis' },
];

const STATUS_LABEL: Record<string, string> = {
  running: 'läuft',
  paused: 'pausiert',
  interrupted: 'unterbrochen',
  error: 'Fehler',
  waiting: 'wartet auf dich',
  idle: '',
};

function taskLabel(t: Task): { text: string; cls: string } {
  if (t.phase === 'done') return { text: 'akzeptiert', cls: 'ok' };
  if (t.phase === 'cancelled') return { text: 'abgebrochen', cls: '' };
  if (t.status === 'error') return { text: 'Fehler', cls: 'err' };
  if (t.status === 'running') return { text: 'läuft', cls: 'warn' };
  return { text: STATUS_LABEL[t.status] || t.phase, cls: 'warn' };
}

type View = 'task' | 'profile' | 'usage' | 'setup' | 'settings';

export function App() {
  const [view, setView] = useState<View>('task');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [env, setEnv] = useState<EnvReport | null>(null);
  const [envBusy, setEnvBusy] = useState(false);
  const [tests, setTests] = useState<{ codex?: ConnTest; claude?: ConnTest }>({});
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profileId, setProfileId] = useState<string>(() => localStorage.getItem('profileId') ?? '');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [gitState, setGitState] = useState<GitState | null>(null);
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('');

  const profile = profiles?.find((p) => p.id === profileId) ?? profiles?.[0] ?? null;
  const projectDir = profile?.projectDir ?? '';

  const refreshEnv = useCallback(async () => {
    setEnvBusy(true);
    try {
      setEnv(await api().invoke<EnvReport>('env:check'));
    } catch (e) {
      setNotice(errText(e));
    } finally {
      setEnvBusy(false);
    }
  }, []);

  useEffect(() => {
    void api().invoke<Settings>('settings:get').then(setSettings);
    void api().invoke<Task[]>('task:list').then(setTasks);
    void api().invoke<Profile[]>('profile:list').then(setProfiles);
    void api().invoke<ModelCatalog>('models:list').then(setCatalog);
    void api().invoke<Quota | null>('quota:get').then(setQuota);
    void refreshEnv();
    const offs = [
      api().on('task:update', (t: Task) => setTasks((prev) => [t, ...prev.filter((x) => x.id !== t.id)].sort((a, b) => b.createdAt - a.createdAt))),
      api().on('agent:event', (e: AgentEvent) => setEvents((prev) => ({ ...prev, [e.taskId]: [...(prev[e.taskId] ?? []), e].slice(-3000) }))),
      api().on('quota:update', (q: Quota) => setQuota(q)),
      api().on('profile:update', (p: Profile) => setProfiles((prev) => (prev ?? []).map((x) => (x.id === p.id ? p : x)))),
    ];
    return () => offs.forEach((off) => off());
  }, [refreshEnv]);

  useEffect(() => {
    if (profile) localStorage.setItem('profileId', profile.id);
    setGitState(null);
    if (projectDir) void api().invoke<GitState>('git:state', projectDir).then(setGitState, () => setGitState(null));
  }, [profile?.id, projectDir]);

  useEffect(() => {
    if (selected && !events[selected]) void api().invoke<AgentEvent[]>('task:log', selected).then((log) => setEvents((prev) => (prev[selected] ? prev : { ...prev, [selected]: log })));
  }, [selected, events]);

  const call = useCallback(async (channel: Parameters<Api['invoke']>[0], ...args: unknown[]) => {
    setNotice('');
    try {
      return await api().invoke(channel, ...args);
    } catch (e) {
      setNotice(errText(e));
      return undefined;
    }
  }, []);

  const pickDir = () => api().invoke<string | null>('dialog:pickDir');
  const saveProfile = async (patch: Partial<Profile>) => {
    const p = (await call('profile:save', patch)) as Profile | undefined;
    if (!p) return;
    setProfiles((prev) => ((prev ?? []).some((x) => x.id === p.id) ? (prev ?? []).map((x) => (x.id === p.id ? p : x)) : [...(prev ?? []), p]));
    setProfileId(p.id);
  };
  const newProfile = async () => {
    const dir = await pickDir();
    if (!dir) return;
    await saveProfile({ projectDir: dir });
    setSelected(null);
    setView('profile');
  };
  const openTask = (id: string) => {
    setSelected(id);
    setView('task');
  };

  // Aufgaben ohne Profil (ältere Einträge) bleiben in jedem Profil sichtbar.
  const mine = tasks.filter((t) => !t.profileId || t.profileId === profile?.id);
  const task = mine.find((t) => t.id === selected) ?? null;
  const active = tasks.find((t) => t.status === 'running') ?? null;

  const pill = (label: string, which: 'codex' | 'claude' | 'git') => {
    const cli = env?.clis[which];
    const auth = which === 'git' ? null : env?.auth[which];
    let cls = 'err';
    let text = 'fehlt';
    if (!env) [cls, text] = ['', 'prüfe…'];
    else if (cli?.path && which === 'git') [cls, text] = ['ok', 'bereit'];
    else if (cli?.path && auth?.loggedIn && (auth.subscription || settings?.allowApiKeyAuth)) [cls, text] = ['ok', auth.method];
    else if (cli?.path && auth?.loggedIn) [cls, text] = ['warn', `kein Abo-Login (${auth.method})`];
    else if (cli?.path) [cls, text] = ['warn', 'nicht angemeldet'];
    return (
      <button className="pill" onClick={() => setView('setup')} title={cli?.version ?? cli?.error ?? ''}>
        <span className={`dot ${cls}`} />
        {label}: {text}
      </button>
    );
  };
  const nav = (v: View, label: string) => (
    <button
      className={`nav ${view === v && !(v === 'task' && task) ? 'on' : ''}`}
      onClick={() => {
        if (v === 'task') setSelected(null);
        setView(v);
      }}
    >
      {label}
    </button>
  );
  const q5 = quota?.fiveHour ? Math.round(quota.fiveHour.utilization * 100) : null;

  return (
    <div className="app">
      <div className="side">
        <div className="brand">
          <Logo />
          Agent Duo
          {settings?.economyMode && <span className="tag ok" title="Sparmodus aktiv">spar</span>}
        </div>
        <div className="side-sec">
          <span className="cap">Profil</span>
          <div className="row nowrap">
            <select className="grow" value={profile?.id ?? ''} onChange={(e) => { setProfileId(e.target.value); setSelected(null); }} disabled={!profiles?.length}>
              {!profiles?.length && <option value="">kein Profil</option>}
              {profiles?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button onClick={newProfile} title="Neues Profil für einen Projektordner anlegen">
              +
            </button>
          </div>
        </div>
        <div className="side-sec navs">
          {nav('task', '+ Neue Aufgabe')}
          {nav('profile', 'Projekt & Notizen')}
          {nav('usage', 'Nutzung')}
          {nav('setup', 'Einrichtung')}
          {nav('settings', 'Einstellungen')}
        </div>
        <span className="cap" style={{ padding: '0 14px' }}>Verlauf</span>
        <div className="hist">
          {mine.map((t) => {
            const l = taskLabel(t);
            return (
              <div key={t.id} className={`item ${t.id === selected && view === 'task' ? 'sel' : ''}`} onClick={() => openTask(t.id)}>
                <div className="t">{t.prompt}</div>
                <div className="m">
                  {t.demo && <span className="tag demo">DEMO</span>}
                  <span className={`tag ${l.cls}`}>{l.text}</span>
                  <span>{new Date(t.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
              </div>
            );
          })}
          {!mine.length && <div className="item muted">Noch keine Aufgaben.</div>}
        </div>
      </div>
      <div className="right">
        <div className="top">
          <div className="proj">
            <b>{profile?.name ?? 'Kein Profil'}</b>
            {projectDir && (
              <span className="path" title={projectDir}>
                {`‎${projectDir}`}
              </span>
            )}
            {projectDir && gitState && (
              <span className={`tag ${gitState.isRepo && gitState.hasCommit ? (gitState.dirtyFiles.length ? 'warn' : 'ok') : 'err'}`}>
                {!gitState.isRepo ? 'kein Git-Repository' : !gitState.hasCommit ? 'noch kein Commit' : `${gitState.branch || 'HEAD'}${gitState.dirtyFiles.length ? ` · ${gitState.dirtyFiles.length} uncommittet` : ' · sauber'}`}
              </span>
            )}
          </div>
          {q5 !== null && (
            <button className="pill" onClick={() => setView('usage')} title="Von Claude Code gemeldete Auslastung des 5-Stunden-Fensters">
              <span className={`dot ${q5 >= 90 ? 'err' : q5 >= 70 ? 'warn' : 'ok'}`} />
              Claude-Kontingent {q5} %
            </button>
          )}
          {pill('Codex', 'codex')}
          {pill('Claude', 'claude')}
          {pill('Git', 'git')}
        </div>
        <div className="main">
          {notice && (
            <div className="banner err row">
              <span className="grow">{notice}</span>
              <button className="link" onClick={() => setNotice('')}>
                schließen
              </button>
            </div>
          )}
          {!!env?.conflicts.length && (
            <div className="banner warn">
              In der Umgebung sind Variablen gesetzt, die API-Abrechnung oder einen anderen Anbieter erzwingen könnten: <code>{env.conflicts.join(', ')}</code>.{' '}
              {settings?.allowApiKeyAuth ? 'Sie werden an die CLIs weitergegeben, weil die API-Nutzung in den Einstellungen erlaubt ist.' : 'Agent Duo gibt sie nicht an die CLIs weiter, damit die Abo-Anmeldung verwendet wird.'}
            </div>
          )}
          {view === 'setup' && <SetupView env={env} busy={envBusy} tests={tests} setTests={setTests} refresh={refreshEnv} settings={settings} />}
          {view === 'settings' && settings && (
            <SettingsView
              settings={settings}
              onSave={async (s) => {
                const saved = (await call('settings:set', s)) as Settings | undefined;
                if (saved) {
                  setSettings(saved);
                  void refreshEnv();
                }
              }}
            />
          )}
          {view === 'usage' && <UsageView tasks={mine} quota={quota} settings={settings} profileName={profile?.name ?? '–'} openTask={openTask} openSettings={() => setView('settings')} />}
          {(view === 'profile' || (view === 'task' && !task)) && profiles && !profile && (
            <div className="card empty">
              <h2>Lege ein Profil für dein Projekt an</h2>
              <p className="muted">Ein Profil merkt sich Projektordner, Modelle, deine Notizen und den Stand der Arbeit – so kannst du jederzeit dort weitermachen, wo du aufgehört hast.</p>
              <button className="primary" onClick={newProfile}>
                Projektordner wählen…
              </button>
            </div>
          )}
          {view === 'profile' && profile && (
            <ProfileView
              profile={profile}
              tasks={mine}
              catalog={catalog}
              save={(patch) => saveProfile({ ...patch, id: profile.id })}
              remove={async () => {
                await call('profile:delete', profile.id);
                setProfiles((prev) => (prev ?? []).filter((x) => x.id !== profile.id));
              }}
              openTask={openTask}
              pickDir={pickDir}
              call={call}
              onTemplate={(prompt) => {
                setDraft(prompt);
                setSelected(null);
                setView('task');
              }}
            />
          )}
          {view === 'task' && !task && (profile || profiles?.length === 0) && (
            <NewTask
              key={`${profile?.id ?? 'none'}|${draft}`}
              draft={draft}
              profile={profile}
              settings={settings}
              catalog={catalog}
              gitState={gitState}
              active={active}
              openProfile={() => setView('profile')}
              onStart={async (prompt, demo, models) => {
                if (profile && !demo) await saveProfile({ id: profile.id, ...models });
                const t = (await call('task:create', prompt, demo ? '' : projectDir, demo, { profileId: profile?.id, ...models })) as Task | undefined;
                if (t) {
                  setDraft('');
                  setSelected(t.id);
                }
              }}
            />
          )}
          {view === 'task' && task && (
            <TaskView
              key={task.id}
              task={task}
              events={events[task.id] ?? []}
              call={call}
              otherActive={!!active && active.id !== task.id}
              openProfile={() => setView('profile')}
              onDeleted={() => {
                setTasks((p) => p.filter((x) => x.id !== task.id));
                setSelected(null);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function NewTask(p: { draft: string; profile: Profile | null; settings: Settings | null; catalog: ModelCatalog | null; gitState: GitState | null; active: Task | null; openProfile: () => void; onStart: (prompt: string, demo: boolean, models: ModelChoice) => void }) {
  const [prompt, setPrompt] = useState(p.draft);
  const [demo, setDemo] = useState(!p.profile);
  const [models, setModels] = useState<ModelChoice>({
    codexModel: p.profile?.codexModel || p.settings?.codexModel || '',
    codexEffort: p.profile?.codexEffort || p.settings?.codexEffort || '',
    claudeModel: p.profile?.claudeModel || p.settings?.claudeModel || '',
    claudeEffort: p.profile?.claudeEffort || p.settings?.claudeEffort || '',
  });
  const repoOk = !!p.gitState?.isRepo && !!p.gitState.hasCommit;
  const can = !!prompt.trim() && !p.active && (demo || (!!p.profile && repoOk));
  const lastNote = p.profile?.journal.at(-1);
  return (
    <>
      <div className="how">
        {[
          ['1', 'Aufgabe beschreiben', 'Schreib in eigenen Worten, was gebaut oder geändert werden soll.'],
          ['2', 'Die Agenten arbeiten', 'Codex plant und prüft, Claude Code setzt um. Du siehst live zu.'],
          ['3', 'Prüfen und veröffentlichen', 'Du schaust dir das Ergebnis an und lädst es mit drei Klicks auf GitHub.'],
        ].map(([n, t, d]) => (
          <div key={n} className="howstep">
            <span className="num">{n}</span>
            <div>
              <b>{t}</b>
              <div className="muted small">{d}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Neue Aufgabe</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Die Agenten arbeiten in einer getrennten Kopie deines Projekts. Ins Internet geht erst etwas, wenn du es im Reiter „Veröffentlichen“ selbst auslöst.
        </p>
        <textarea rows={7} placeholder="Was soll umgesetzt werden?" value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus />
        {!demo && (
          <>
            <h3>Modelle für diese Aufgabe</h3>
            <ModelPicker catalog={p.catalog} value={models} onChange={setModels} />
          </>
        )}
        {!demo && p.profile && p.gitState && !repoOk && <div className="banner err" style={{ marginTop: 10 }}>Der Ordner ist kein Git-Repository mit mindestens einem Commit. Agent Duo legt selbst kein Repository an.</div>}
        {!demo && repoOk && !!p.gitState!.dirtyFiles.length && (
          <div className="banner warn" style={{ marginTop: 10 }}>
            {p.gitState!.dirtyFiles.length} uncommittete Änderung(en) im Projektordner.{' '}
            {(p.settings?.useWorktree ?? true) ? 'Sie bleiben unberührt; der Agent arbeitet in einem separaten Worktree auf Basis des letzten Commits und sieht sie nicht.' : 'Sie werden vor dem Start unter refs/agent-duo/backup/… gesichert; der Agent arbeitet direkt im Projektordner.'}
          </div>
        )}
        {p.active && <div className="banner info" style={{ marginTop: 10 }}>Es läuft bereits eine Aufgabe. Es wird immer nur eine Aufgabe gleichzeitig ausgeführt.</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={!can} onClick={() => p.onStart(prompt, demo, models)}>
            Start
          </button>
          <label className="row" style={{ margin: 0 }}>
            <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} /> Demo-Modus (simulierte Antworten, keine CLI-Aufrufe, keine Dateiänderungen)
          </label>
        </div>
      </div>
      {p.profile && (p.profile.notes.trim() || lastNote) && (
        <div className="card">
          <div className="row">
            <h2 className="grow" style={{ margin: 0 }}>
              Wo du stehen geblieben bist
            </h2>
            <button className="link" onClick={p.openProfile}>
              Notizen bearbeiten
            </button>
          </div>
          {p.profile.notes.trim() && <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{p.profile.notes.trim().slice(0, 600)}</p>}
          {lastNote && (
            <p className="muted small" style={{ margin: '8px 0 0' }}>
              Letzter Journal-Eintrag ({new Date(lastNote.ts).toLocaleDateString('de-DE')}): {lastNote.text}
            </p>
          )}
        </div>
      )}
    </>
  );
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function PlanEditor(p: { plan: Plan; editable: boolean; busy: boolean; onApprove: (plan: Plan) => void }) {
  const [goal, setGoal] = useState(p.plan.goal);
  const [criteria, setCriteria] = useState(p.plan.acceptance_criteria.join('\n'));
  const [steps, setSteps] = useState(p.plan.steps.join('\n'));
  const [files, setFiles] = useState(p.plan.relevant_files.join('\n'));
  const [checks, setChecks] = useState(p.plan.checks.map((c) => `${c.name} :: ${c.command}`).join('\n'));
  const [claudeTask, setClaudeTask] = useState(p.plan.claude_task);
  const ro = !p.editable;
  const build = (): Plan => ({
    goal,
    acceptance_criteria: lines(criteria),
    steps: lines(steps),
    relevant_files: lines(files),
    checks: lines(checks).map((l) => {
      const i = l.indexOf('::');
      return i < 0 ? { name: l, command: l } : { name: l.slice(0, i).trim(), command: l.slice(i + 2).trim() };
    }),
    claude_task: claudeTask,
  });
  return (
    <div>
      {p.editable && <div className="banner info">Bitte Plan, Prüfbefehle und Auftrag prüfen und bei Bedarf bearbeiten. Die Prüfbefehle führt Agent Duo nach der Implementierung selbst aus.</div>}
      <label>Ziel</label>
      <textarea rows={2} value={goal} readOnly={ro} onChange={(e) => setGoal(e.target.value)} />
      <div className="grid2">
        <div>
          <label>Akzeptanzkriterien (eine Zeile je Kriterium)</label>
          <textarea rows={6} value={criteria} readOnly={ro} onChange={(e) => setCriteria(e.target.value)} />
        </div>
        <div>
          <label>Arbeitsschritte</label>
          <textarea rows={6} value={steps} readOnly={ro} onChange={(e) => setSteps(e.target.value)} />
        </div>
        <div>
          <label>Relevante Dateien</label>
          <textarea className="mono" rows={4} value={files} readOnly={ro} onChange={(e) => setFiles(e.target.value)} />
        </div>
        <div>
          <label>Prüfungen (Name :: Befehl, ohne Shell-Syntax)</label>
          <textarea className="mono" rows={4} value={checks} readOnly={ro} onChange={(e) => setChecks(e.target.value)} />
        </div>
      </div>
      <label>Arbeitsauftrag für Claude Code</label>
      <textarea rows={10} value={claudeTask} readOnly={ro} onChange={(e) => setClaudeTask(e.target.value)} />
      {p.editable && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={p.busy || !goal.trim() || !claudeTask.trim()} onClick={() => p.onApprove(build())}>
            Plan bestätigen und Claude starten
          </button>
        </div>
      )}
    </div>
  );
}

function Stream(p: { events: AgentEvent[]; cls?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [p.events.length]);
  return (
    <div
      className={`stream ${p.cls ?? ''}`}
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {p.events.map((e, i) => (
        <div key={i} className={`e ${e.kind}`}>
          {e.text}
        </div>
      ))}
      {!p.events.length && <span className="muted">Noch keine Ausgabe.</span>}
    </div>
  );
}

function Diff({ text }: { text: string }) {
  if (!text.trim()) return <p className="muted">Keine Änderungen.</p>;
  return (
    <pre className="diff">
      {text.split('\n').map((l, i) => {
        const cls = l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
        return (
          <div key={i} className={cls}>
            {l || ' '}
          </div>
        );
      })}
    </pre>
  );
}

const DECISION: Record<string, { text: string; cls: string }> = {
  accepted: { text: 'akzeptiert', cls: 'ok' },
  needs_fix: { text: 'Korrektur erforderlich', cls: 'warn' },
  needs_user: { text: 'Nutzereingabe erforderlich', cls: 'err' },
};

function TaskView(p: { task: Task; events: AgentEvent[]; call: (c: any, ...a: unknown[]) => Promise<unknown>; otherActive: boolean; onDeleted: () => void; openProfile: () => void }) {
  const t = p.task;
  const [tab, setTab] = useState<'map' | 'plan' | 'live' | 'diff' | 'tests' | 'review' | 'usage' | 'publish'>(t.phase === 'await_plan' ? 'plan' : 'map');
  const [roundIdx, setRoundIdx] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const prevPhase = useRef(t.phase);
  useEffect(() => {
    if (prevPhase.current !== t.phase) {
      if (t.phase === 'await_plan') setTab('plan');
      else if (t.phase === 'await_user') setTab(t.rounds.at(-1)?.review ? 'review' : 'live');
      else if (prevPhase.current === 'await_plan') setTab('map');
      prevPhase.current = t.phase;
    }
  }, [t.phase, t.rounds]);

  const running = t.status === 'running';
  const resumable = ['paused', 'interrupted', 'error'].includes(t.status) && ['plan', 'implement', 'test', 'review'].includes(t.phase);
  const finished = t.phase === 'done' || t.phase === 'cancelled';
  const round = t.rounds.length ? t.rounds[Math.min(roundIdx ?? t.rounds.length - 1, t.rounds.length - 1)] : undefined;
  const curStep = t.phase === 'await_user' ? (t.rounds.at(-1)?.review ? 'review' : 'implement') : t.phase === 'cancelled' ? '' : t.phase;
  const curIdx = STEPS.findIndex((s) => s.key === curStep);
  const by = useMemo(() => ({ codex: p.events.filter((e) => e.agent === 'codex'), claude: p.events.filter((e) => e.agent === 'claude'), system: p.events.filter((e) => e.agent === 'system') }), [p.events]);
  const tree = useMemo(() => taskTree(t, p.events), [t, p.events]);
  const models = [t.codexModel && `Codex: ${t.codexModel}${t.codexEffort ? ` (${t.codexEffort})` : ''}`, t.claudeModel && `Claude: ${t.claudeModel}${t.claudeEffort ? ` (${t.claudeEffort})` : ''}`].filter(Boolean).join(' · ');
  const fixRounds = t.rounds.length ? t.rounds.at(-1)!.n : 0;
  const hasDenials = !!t.rounds.at(-1)?.denials?.length && !t.rounds.at(-1)?.checks;
  const sendAnswer = (mode: AnswerMode) => p.call('task:answer', t.id, mode, answer).then(() => setAnswer(''));
  const usage = t.usage.codex.inputTokens + t.usage.claude.inputTokens > 0;

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 className="grow" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {t.demo && <span className="tag demo" style={{ marginRight: 8 }}>DEMO – simulierte Antworten</span>}
            {t.prompt.length > 220 ? `${t.prompt.slice(0, 220)}…` : t.prompt}
          </h2>
          <button disabled={!running || t.pauseRequested} onClick={() => p.call('task:pause', t.id)} title="Der aktuelle Schritt wird noch abgeschlossen">
            {t.pauseRequested ? 'Pause angefordert…' : 'Pause nach Schritt'}
          </button>
          <button disabled={!resumable || p.otherActive} onClick={() => p.call('task:resume', t.id)}>
            {t.status === 'error' ? 'Schritt erneut versuchen' : 'Fortsetzen'}
          </button>
          <button className="danger" disabled={finished} onClick={() => p.call('task:cancel', t.id)}>
            Sofort abbrechen
          </button>
        </div>
        <div className="steps" style={{ marginTop: 10 }}>
          {STEPS.map((s, i) => (
            <div key={s.key} className={`step ${t.phase === 'done' || i < curIdx ? 'done' : ''} ${i === curIdx && t.phase !== 'done' ? `cur ${running ? 'run' : ''} ${t.status === 'error' ? 'bad' : ''}` : ''}`}>
              {s.label}
              {s.key === 'implement' && fixRounds > 0 && ` · Korrektur ${fixRounds}/${t.maxFixRounds}`}
            </div>
          ))}
        </div>
        <div className="row small muted" style={{ marginTop: 8 }}>
          <span>
            Zustand: <b style={{ color: 'var(--text)' }}>{taskLabel(t).text}</b>
          </span>
          {t.workDir && !t.demo && (
            <span>
              · Arbeitsverzeichnis:{' '}
              <button className="link" onClick={() => p.call('shell:reveal', t.id)} title={t.workDir}>
                {t.branch ? `Branch ${t.branch}` : 'öffnen'}
              </button>
            </span>
          )}
          {t.backupRef && <span>· Sicherung: <code>{t.backupRef}</code></span>}
          {models && <span>· {models}</span>}
          {usage && (
            <span title="Von den CLIs gemeldete Token; keine Kostenangabe">
              · Token laut CLI – Codex {t.usage.codex.inputTokens.toLocaleString('de-DE')} ein / {t.usage.codex.outputTokens.toLocaleString('de-DE')} aus, Claude {t.usage.claude.inputTokens.toLocaleString('de-DE')} ein / {t.usage.claude.outputTokens.toLocaleString('de-DE')} aus
            </span>
          )}
          <span className="grow" />
          {!running && (
            <button className="link" onClick={() => p.call('task:delete', t.id).then(p.onDeleted)} title="Entfernt nur den Eintrag; Worktree und Änderungen bleiben erhalten">
              Eintrag löschen
            </button>
          )}
        </div>
      </div>

      {t.status === 'interrupted' && <div className="banner warn">Diese Aufgabe wurde durch das Beenden der App unterbrochen. Sie wird nicht automatisch neu gestartet – mit „Fortsetzen“ wird der Schritt „{STEPS[curIdx]?.label}“ erneut ausgeführt.</div>}
      {t.status === 'error' && t.error && (
        <div className="banner err">
          <b>{{ auth: 'Anmeldung erforderlich', limit: 'Nutzungslimit erreicht', timeout: 'Zeitlimit überschritten', invalid_output: 'Ungültige strukturierte Antwort', not_found: 'Programm nicht gefunden', git: 'Git-Problem', cli: 'CLI-Fehler', cancelled: 'Abgebrochen' }[t.error.kind]}:</b> {t.error.message}
          {(t.error.kind === 'auth' || t.error.kind === 'limit') && <div className="small muted">Es wird nicht automatisch wiederholt und nicht auf einen anderen Anbieter oder API-Abrechnung gewechselt.</div>}
        </div>
      )}
      {t.phase === 'done' && !t.demo && (
        <div className="banner info">
          Ergebnis akzeptiert. Die Änderungen liegen {t.branch && t.workDir !== t.projectDir ? 'in einer getrennten Kopie deines Projekts' : 'im Projektordner'} und sind noch nicht veröffentlicht.{' '}
          <button className="link" onClick={() => setTab('publish')}>
            Jetzt veröffentlichen →
          </button>
        </div>
      )}
      {t.phase === 'await_user' && (
        <div className="banner warn">
          <b>Deine Entscheidung ist nötig.</b>
          <div style={{ whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{t.userQuestion}</div>
          {hasDenials && (
            <ul>
              {t.rounds.at(-1)!.denials!.map((d, i) => (
                <li key={i}>
                  <code>{d.tool}</code> – {d.detail}
                </li>
              ))}
            </ul>
          )}
          <textarea rows={3} placeholder="Antwort oder zusätzlicher Auftrag an Claude…" value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={!answer.trim() || p.otherActive} onClick={() => sendAnswer('fix')}>
              An Claude senden
            </button>
            {hasDenials && (
              <>
                <button disabled={p.otherActive} onClick={() => sendAnswer('allow_tools')}>
                  Werkzeuge für diese Aufgabe freigeben
                </button>
                <button onClick={() => p.call('task:openTerminal', t.id)}>Interaktiv im Terminal fortsetzen</button>
                <button disabled={p.otherActive} onClick={() => sendAnswer('continue')}>
                  Ohne Freigabe weiter zur Prüfung
                </button>
              </>
            )}
            <button onClick={() => sendAnswer('accept')}>Ergebnis so übernehmen</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="tabs">
          {(
            [
              ['map', 'Karte'],
              ['plan', 'Plan & Auftrag'],
              ['live', 'Live-Ausgaben'],
              ['diff', 'Git-Diff'],
              ['tests', 'Tests'],
              ['review', 'Review'],
              ['usage', 'Verbrauch'],
              ['publish', 'Veröffentlichen'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
          <span className="grow" />
          {t.rounds.length > 1 && (tab === 'diff' || tab === 'tests' || tab === 'review') && (
            <span className="row small">
              Runde:
              {t.rounds.map((r, i) => (
                <button key={i} className={round === r ? 'on' : ''} onClick={() => setRoundIdx(i)}>
                  {i === 0 ? 'Implementierung' : `${i}`}
                </button>
              ))}
            </span>
          )}
        </div>
        <div style={{ paddingTop: 10 }}>
          {tab === 'map' && <Mindmap root={tree} />}
          {tab === 'usage' && <TaskUsage task={t} />}
          {tab === 'publish' && <PublishPanel task={t} call={p.call} openProfile={p.openProfile} />}
          {tab === 'plan' && (t.plan ? <PlanEditor key={t.phase} plan={t.plan} editable={t.phase === 'await_plan'} busy={p.otherActive} onApprove={(plan) => p.call('task:approvePlan', t.id, plan)} /> : <p className="muted">{running ? 'Codex erstellt den Plan…' : 'Noch kein Plan vorhanden.'}</p>)}
          {tab === 'live' && (
            <>
              <div className="live">
                <div>
                  <h3 className="codex" style={{ marginTop: 0 }}>Codex · Planung und Review (nur lesend)</h3>
                  <Stream events={by.codex} />
                </div>
                <div>
                  <h3 className="claude" style={{ marginTop: 0 }}>Claude Code · Implementierung</h3>
                  <Stream events={by.claude} />
                </div>
              </div>
              <h3>Ablauf</h3>
              <Stream events={by.system} cls="sys" />
            </>
          )}
          {tab === 'diff' && (round?.diff !== undefined ? <Diff text={round.diff} /> : <p className="muted">Der Diff wird nach der Implementierung erfasst.</p>)}
          {tab === 'tests' &&
            (round?.checks ? (
              round.checks.length ? (
                round.checks.map((c, i) => (
                  <div key={i}>
                    <div className="row">
                      <span className={`tag ${c.exitCode === 0 ? 'ok' : 'err'}`}>{c.exitCode === null ? 'nicht ausgeführt' : `Exit-Code ${c.exitCode}`}</span>
                      <b>{c.name}</b>
                      <code>{c.command}</code>
                      <span className="muted small">{(c.durationMs / 1000).toFixed(1)} s</span>
                      {c.error && <span style={{ color: 'var(--err)' }}>{c.error}</span>}
                    </div>
                    {c.output && <pre className="wrap">{c.output}</pre>}
                  </div>
                ))
              ) : (
                <p className="muted">Für diese Aufgabe sind keine Prüfbefehle im Plan hinterlegt.</p>
              )
            ) : (
              <p className="muted">Noch keine Testergebnisse.</p>
            ))}
          {tab === 'review' &&
            (round ? (
              <>
                <h3 style={{ marginTop: 0 }}>Auftrag an Claude</h3>
                <pre className="wrap">{round.task}</pre>
                {round.claudeSummary !== undefined && (
                  <>
                    <h3>Zusammenfassung von Claude</h3>
                    <pre className="wrap">{round.claudeSummary}</pre>
                  </>
                )}
                {round.review ? (
                  <>
                    <h3>
                      Entscheidung von Codex: <span className={`tag ${DECISION[round.review.decision].cls}`}>{DECISION[round.review.decision].text}</span>
                    </h3>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{round.review.summary}</p>
                    {!!round.review.findings.length && (
                      <table>
                        <thead>
                          <tr>
                            <th>Schwere</th>
                            <th>Datei</th>
                            <th>Befund</th>
                          </tr>
                        </thead>
                        <tbody>
                          {round.review.findings.map((f, i) => (
                            <tr key={i}>
                              <td>
                                <span className={`tag ${f.severity === 'high' ? 'err' : f.severity === 'medium' ? 'warn' : ''}`}>{{ high: 'hoch', medium: 'mittel', low: 'niedrig' }[f.severity]}</span>
                              </td>
                              <td>
                                <code>{f.file}</code>
                              </td>
                              <td>{f.description}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {round.review.fix_task && (
                      <>
                        <h3>Folgeauftrag</h3>
                        <pre className="wrap">{round.review.fix_task}</pre>
                      </>
                    )}
                  </>
                ) : (
                  <p className="muted">Für diese Runde liegt noch kein Review vor.</p>
                )}
              </>
            ) : (
              <p className="muted">Noch keine Runde gestartet.</p>
            ))}
        </div>
      </div>
    </>
  );
}
