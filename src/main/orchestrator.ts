// Persistente Zustandsmaschine:
// plan → (await_plan) → implement → test → review → [implement …] → done | await_user | cancelled
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentName, AnswerMode, Plan, Quota, Round, Settings, Task, TaskOptions, Usage, UsageStep } from '../shared/types';
import type { Implementer, Planner } from './adapters/types';
import { splitTools } from './adapters/claude';
import { runChecks } from './checks';
import { fixPrompt, implementPrompt, PLAN_SCHEMA, planPrompt, REVIEW_SCHEMA, reviewPrompt, validatePlan, validateReview } from './contracts';
import type { Git } from './git';
import { AgentError, redact, type ProcessManager } from './proc';
import type { Store } from './store';

export interface Runtime {
  planner: Planner;
  implementer: Implementer;
  git: Git | null; // null im Demo-Modus
  env: NodeJS.ProcessEnv;
  settings: Settings;
  context?: string; // Vorgaben und Notizen aus dem Projektprofil
}

export interface OrchestratorDeps {
  store: Store;
  pm: ProcessManager;
  worktreeRoot: string;
  /** Liefert Adapter und Umgebung für eine Aufgabe; wirft AgentError bei fehlender CLI/Anmeldung. */
  resolve(task: Task): Promise<Runtime>;
  onTask(task: Task): void;
  onEvent(e: AgentEvent): void;
  onQuota?(q: Quota): void;
  /** Kurzer Stand nach einem Review – für das Projektjournal. */
  onJournal?(task: Task, text: string): void;
}

const RUNNABLE = ['plan', 'implement', 'test', 'review'];

export class Orchestrator {
  private tasks = new Map<string, Task>();
  private activeId: string | null = null;
  private cancelRequested = false;
  private running: Promise<void> | null = null;

  constructor(private d: OrchestratorDeps) {}

  /** Lädt gespeicherte Aufgaben. Laufende Aufgaben werden als unterbrochen markiert – nie automatisch neu gestartet. */
  init(): void {
    for (const t of this.d.store.loadTasks()) {
      if (t.status === 'running') {
        t.status = 'interrupted';
        t.pauseRequested = false;
        this.d.store.saveTask(t);
      }
      this.tasks.set(t.id, t);
    }
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new Error('Aufgabe nicht gefunden');
    return t;
  }

  /** Wartet auf das Ende des aktuellen Laufs (für Tests und sauberes Beenden). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  create(prompt: string, projectDir: string, demo: boolean, maxFixRounds: number, opts: TaskOptions = {}): Task {
    if (!prompt.trim()) throw new Error('Bitte eine Aufgabe eingeben.');
    if (!demo && !projectDir) throw new Error('Bitte zuerst einen Projektordner wählen.');
    this.assertFree();
    const now = Date.now();
    const zero = (): Usage => ({ inputTokens: 0, outputTokens: 0 });
    const t: Task = {
      ...opts,
      usageLog: [],
      id: `${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`,
      prompt: prompt.trim(),
      projectDir,
      demo,
      createdAt: now,
      updatedAt: now,
      phase: 'plan',
      status: 'idle',
      pauseRequested: false,
      rounds: [],
      maxFixRounds,
      extraAllowedTools: [],
      usage: { codex: zero(), claude: zero() },
    };
    this.tasks.set(t.id, t);
    this.start(t);
    return t;
  }

  approvePlan(id: string, plan: unknown): Task {
    const t = this.get(id);
    if (t.phase !== 'await_plan') throw new Error('Kein Plan zur Bestätigung offen.');
    this.assertFree();
    t.plan = validatePlan(plan);
    this.beginRound(t, t.plan.claude_task);
    this.start(t);
    return t;
  }

  pause(id: string): Task {
    const t = this.get(id);
    if (this.activeId === id) {
      t.pauseRequested = true;
      this.log(t, 'system', 'info', 'Pause angefordert – der aktuelle Schritt wird noch abgeschlossen.');
      this.persist(t);
    }
    return t;
  }

  resume(id: string): Task {
    const t = this.get(id);
    if (!RUNNABLE.includes(t.phase) || !['paused', 'interrupted', 'error'].includes(t.status)) throw new Error('Diese Aufgabe kann nicht fortgesetzt werden.');
    this.assertFree();
    this.start(t);
    return t;
  }

  /** Sofortiger Abbruch: beendet alle Kindprozesse; bereits entstandene Änderungen bleiben erhalten. */
  cancel(id: string): Task {
    const t = this.get(id);
    if (this.activeId === id) {
      this.cancelRequested = true;
      this.d.pm.killAll();
    } else if (t.phase !== 'done' && t.phase !== 'cancelled') {
      t.phase = 'cancelled';
      t.status = 'idle';
      this.log(t, 'system', 'info', 'Aufgabe abgebrochen. Vorhandene Änderungen bleiben erhalten.');
      this.persist(t);
    }
    return t;
  }

  answer(id: string, mode: AnswerMode, text: string): Task {
    const t = this.get(id);
    if (t.phase !== 'await_user') throw new Error('Diese Aufgabe wartet nicht auf eine Eingabe.');
    this.assertFree();
    const last = t.rounds.at(-1);
    t.userQuestion = undefined;
    if (mode === 'accept') {
      t.phase = 'done';
      t.status = 'idle';
      this.log(t, 'system', 'info', 'Vom Nutzer als abgeschlossen übernommen.');
      this.persist(t);
      return t;
    }
    if (mode === 'continue') {
      // Nach verweigerten Freigaben ohne weitere Implementierung prüfen lassen.
      t.phase = last?.claudeSummary !== undefined && !last.checks ? 'test' : 'review';
    } else if (mode === 'allow_tools') {
      const tools = [...new Set((last?.denials ?? []).map((d) => d.tool))];
      t.extraAllowedTools = [...new Set([...t.extraAllowedTools, ...tools])];
      this.log(t, 'system', 'info', `Für diese Aufgabe freigegeben: ${tools.join(', ') || '(nichts)'}`);
      this.beginRound(t, 'Setze den vorherigen Auftrag fort. Die zuvor verweigerten Werkzeuge sind jetzt für diese Aufgabe freigegeben.', false);
    } else {
      if (!text.trim()) throw new Error('Bitte einen Hinweis oder Auftrag eingeben.');
      this.beginRound(t, `Hinweis des Nutzers:\n${text.trim()}`, false);
    }
    this.start(t);
    return t;
  }

  delete(id: string): void {
    if (this.activeId === id) throw new Error('Laufende Aufgabe zuerst abbrechen.');
    this.tasks.delete(id);
    this.d.store.deleteTask(id);
  }

  // --- intern ---

  private assertFree(): void {
    // Nur ein Lauf gleichzeitig: verhindert parallele Schreibzugriffe.
    if (this.activeId) throw new Error('Es läuft bereits eine Aufgabe. Bitte warten, pausieren oder abbrechen.');
  }

  private beginRound(t: Task, task: string, countsAsFix = true): void {
    const prev = t.rounds.at(-1);
    const n = prev ? prev.n + (countsAsFix ? 1 : 0) : 0;
    t.rounds.push({ n, task });
    t.phase = 'implement';
  }

  private persist(t: Task): void {
    this.d.store.saveTask(t);
    this.d.onTask(t);
  }

  private log(t: Task, agent: AgentName, kind: AgentEvent['kind'], text: string): void {
    const e: AgentEvent = { taskId: t.id, agent, kind, text: redact(text), ts: Date.now() };
    this.d.store.appendLog(e);
    this.d.onEvent(e);
  }

  private addUsage(t: Task, who: 'codex' | 'claude', step: UsageStep, u?: Usage): void {
    if (!u) return;
    const sum = t.usage[who];
    sum.inputTokens += u.inputTokens;
    sum.outputTokens += u.outputTokens;
    sum.cachedTokens = (sum.cachedTokens ?? 0) + (u.cachedTokens ?? 0);
    (t.usageLog ??= []).push({ ...u, ts: Date.now(), agent: who, step, round: t.rounds.at(-1)?.n ?? 0 });
  }

  private opts(t: Task, rt: Runtime) {
    const s = rt.settings;
    return {
      economy: s.economyMode,
      context: rt.context ?? '',
      codexModel: t.codexModel ?? s.codexModel,
      claudeModel: t.claudeModel ?? s.claudeModel,
      codexEffort: t.codexEffort ?? s.codexEffort,
      claudeEffort: t.claudeEffort ?? s.claudeEffort,
    };
  }

  private start(t: Task): void {
    this.activeId = t.id;
    this.cancelRequested = false;
    t.status = 'running';
    t.error = undefined;
    t.pauseRequested = false;
    this.persist(t);
    this.running = this.loop(t).finally(() => {
      this.running = null;
    });
  }

  private async loop(t: Task): Promise<void> {
    try {
      const rt = await this.d.resolve(t);
      while (RUNNABLE.includes(t.phase)) {
        if (this.cancelRequested) throw new AgentError('cancelled', 'Abgebrochen');
        if (t.phase === 'plan') await this.stepPlan(t, rt);
        else if (t.phase === 'implement') await this.stepImplement(t, rt);
        else if (t.phase === 'test') await this.stepTest(t, rt);
        else await this.stepReview(t, rt);
        if (this.cancelRequested) throw new AgentError('cancelled', 'Abgebrochen');
        if (t.pauseRequested && RUNNABLE.includes(t.phase)) {
          t.status = 'paused';
          t.pauseRequested = false;
          this.log(t, 'system', 'info', 'Pausiert.');
          return;
        }
        this.persist(t);
      }
      t.status = t.phase === 'await_plan' || t.phase === 'await_user' ? 'waiting' : 'idle';
      if (t.phase === 'done') this.log(t, 'system', 'info', 'Ergebnis akzeptiert. Es wurde nichts gepusht oder gemergt.');
    } catch (e) {
      const err = e instanceof AgentError ? e : new AgentError('cli', (e as Error)?.message ?? String(e));
      if (err.kind === 'cancelled' || this.cancelRequested) {
        t.phase = 'cancelled';
        t.status = 'idle';
        this.log(t, 'system', 'info', 'Abgebrochen. Kindprozesse wurden beendet; vorhandene Änderungen bleiben erhalten.');
      } else {
        t.status = 'error';
        t.error = { kind: err.kind, message: redact(err.message) };
        this.log(t, 'system', 'error', t.error.message);
      }
    } finally {
      t.pauseRequested = false;
      this.activeId = null;
      this.cancelRequested = false;
      this.persist(t);
    }
  }

  /** Fehlerhafte strukturierte Antworten werden genau einmal neu angefordert. */
  private async structured<T>(t: Task, run: (repairNote: string) => Promise<unknown>, validate: (d: unknown) => T): Promise<T> {
    try {
      return validate(await run(''));
    } catch (e) {
      if (!(e instanceof AgentError) || e.kind !== 'invalid_output' || this.cancelRequested) throw e;
      this.log(t, 'system', 'error', `${e.message} – ein erneuter Versuch folgt.`);
      return validate(await run(`\n\nDeine vorherige Antwort war ungültig (${e.message}). Antworte ausschließlich mit gültigem JSON gemäß Schema.`));
    }
  }

  private async stepPlan(t: Task, rt: Runtime): Promise<void> {
    if (rt.git) await this.requireRepo(t, rt.git);
    const o = this.opts(t, rt);
    this.log(t, 'system', 'info', `Codex erstellt den Plan (nur Lesezugriff${o.economy ? ', Sparmodus' : ''}).`);
    t.plan = await this.structured(
      t,
      async (note) => {
        const r = await rt.planner.run({
          cwd: t.projectDir,
          prompt: planPrompt(t.prompt, o) + note,
          schema: PLAN_SCHEMA,
          model: o.codexModel,
          effort: o.codexEffort,
          timeoutMs: rt.settings.planTimeoutMin * 60_000,
          emit: (k, x) => this.log(t, 'codex', k, x),
        });
        this.addUsage(t, 'codex', 'plan', r.usage);
        return r.data;
      },
      validatePlan,
    );
    if (rt.settings.confirmPlan) t.phase = 'await_plan';
    else this.beginRound(t, t.plan.claude_task);
  }

  private async requireRepo(t: Task, git: Git): Promise<void> {
    const s = await git.state(t.projectDir);
    if (!s.isRepo) throw new AgentError('git', 'Der Projektordner ist kein Git-Repository. Bitte zuerst "git init" und einen ersten Commit anlegen.');
    if (!s.hasCommit) throw new AgentError('git', 'Das Repository hat noch keinen Commit. Bitte zuerst einen ersten Commit anlegen.');
  }

  /** Prüft den Git-Zustand und richtet das Arbeitsverzeichnis ein, ohne Nutzeränderungen anzufassen. */
  private async prepareWorkspace(t: Task, rt: Runtime): Promise<void> {
    if (t.workDir) return;
    if (!rt.git) {
      t.workDir = t.projectDir;
      return;
    }
    await this.requireRepo(t, rt.git);
    const s = await rt.git.state(t.projectDir);
    t.dirtyAtStart = s.dirtyFiles.length > 0;
    const head = await rt.git.head(t.projectDir);
    if (rt.settings.useWorktree) {
      const dir = path.join(this.d.worktreeRoot, t.id);
      const branch = `agent-duo/${t.id}`;
      await rt.git.addWorktree(t.projectDir, dir, branch);
      t.workDir = dir;
      t.branch = branch;
      t.baseRef = head;
      this.log(t, 'system', 'info', `Worktree angelegt: ${dir} (Branch ${branch}).${t.dirtyAtStart ? ' Uncommittete Änderungen im Projektordner bleiben unberührt und sind im Worktree nicht enthalten.' : ''}`);
    } else {
      const backup = await rt.git.backupDirty(t.projectDir, t.id);
      t.workDir = t.projectDir;
      t.branch = s.branch;
      t.baseRef = backup ?? head;
      t.backupRef = backup ? `refs/agent-duo/backup/${t.id}` : undefined;
      this.log(t, 'system', 'info', backup ? `Direkt im Projektordner. Bestehende Änderungen gesichert unter ${t.backupRef}.` : 'Direkt im Projektordner (Arbeitsverzeichnis war sauber).');
    }
    this.persist(t);
  }

  private async stepImplement(t: Task, rt: Runtime): Promise<void> {
    if (!t.plan) throw new AgentError('cli', 'Kein Plan vorhanden.');
    await this.prepareWorkspace(t, rt);
    if (!t.rounds.length) this.beginRound(t, t.plan.claude_task);
    const round = t.rounds.at(-1)!;
    const first = t.rounds.length === 1;
    this.log(t, 'system', 'info', first ? 'Claude Code implementiert.' : `Claude Code korrigiert (Runde ${round.n}).`);
    const o = this.opts(t, rt);
    const allowedTools = [...new Set([...splitTools(rt.settings.claudeAllowedTools), ...t.extraAllowedTools])];
    const run = (sessionId: string | undefined) =>
      rt.implementer.run({
        cwd: t.workDir!,
        // Ohne fortgesetzte Sitzung braucht Claude den vollständigen Kontext erneut.
        prompt: first ? implementPrompt(t.plan!, o) : sessionId ? fixPrompt(round.task, round.n, o.economy) : `${implementPrompt(t.plan!, o)}\n\n${fixPrompt(round.task, round.n, o.economy)}`,
        model: o.claudeModel,
        effort: o.claudeEffort,
        economy: o.economy,
        onQuota: (q) => this.d.onQuota?.(q),
        timeoutMs: rt.settings.implementTimeoutMin * 60_000,
        sessionId,
        allowedTools,
        emit: (k, x) => this.log(t, 'claude', k, x),
      });
    let res;
    try {
      res = await run(t.claudeSessionId);
    } catch (e) {
      if (!(e instanceof AgentError) || e.kind !== 'cli' || !t.claudeSessionId || this.cancelRequested) throw e;
      this.log(t, 'system', 'error', `Sitzung konnte nicht fortgesetzt werden (${e.message}). Neuer Versuch mit frischer Sitzung.`);
      t.claudeSessionId = undefined;
      res = await run(undefined);
    }
    this.addUsage(t, 'claude', 'implement', res.usage);
    t.claudeSessionId = res.sessionId ?? t.claudeSessionId;
    round.claudeSummary = res.summary;
    round.denials = res.denials;
    if (res.denials.length && rt.settings.pauseOnDenial) {
      // Freigaben sind im Print-Modus nicht interaktiv möglich → anhalten und Nutzer entscheiden lassen.
      t.phase = 'await_user';
      t.userQuestion = `Claude Code wurden ${res.denials.length} Aktion(en) nicht freigegeben. Du kannst die Werkzeuge für diese Aufgabe freigeben, interaktiv im Terminal fortsetzen oder ohne sie weiter prüfen lassen.`;
    } else t.phase = 'test';
  }

  private async stepTest(t: Task, rt: Runtime): Promise<void> {
    const round = t.rounds.at(-1)!;
    if (rt.git) {
      this.log(t, 'system', 'info', 'Prüfungen werden ausgeführt.');
      round.checks = await runChecks(this.d.pm, t.plan?.checks ?? [], t.workDir!, rt.env, rt.settings.checkTimeoutMin * 60_000, (x) => this.log(t, 'system', 'info', x));
      const d = await rt.git.diff(t.workDir!, t.baseRef!);
      round.diff = redact(d.diff);
      round.diffHash = d.hash;
    } else {
      round.checks = [];
      round.diff = '(Demo-Modus – es wurden keine Dateien geändert)';
      round.diffHash = `demo-${t.rounds.length}`;
    }
    const prev = t.rounds.length > 1 ? t.rounds[t.rounds.length - 2] : undefined;
    if (prev?.review?.decision === 'needs_fix' && prev.diffHash === round.diffHash) {
      t.phase = 'await_user';
      t.userQuestion = 'Kein Fortschritt: Die Korrekturrunde hat den Diff nicht verändert. Der Ablauf wurde angehalten.';
      this.log(t, 'system', 'error', t.userQuestion);
      return;
    }
    t.phase = 'review';
  }

  private async stepReview(t: Task, rt: Runtime): Promise<void> {
    const round = t.rounds.at(-1)!;
    const o = this.opts(t, rt);
    this.log(t, 'system', 'info', `Codex prüft das Ergebnis (Prüfung ${round.n + 1}, nur Lesezugriff).`);
    const prompt = reviewPrompt({
      task: t.prompt,
      plan: t.plan!,
      diff: round.diff ?? '',
      claudeSummary: round.claudeSummary ?? '',
      checks: round.checks ?? [],
      denials: round.denials ?? [],
      round: round.n,
      maxFixRounds: t.maxFixRounds,
      economy: o.economy,
      context: o.context,
    });
    const call = async (threadId: string | undefined, note: string) => {
      const r = await rt.planner.run({
        cwd: t.workDir ?? t.projectDir,
        prompt: prompt + note,
        schema: REVIEW_SCHEMA,
        model: o.codexModel,
        effort: o.codexEffort,
        timeoutMs: rt.settings.reviewTimeoutMin * 60_000,
        threadId,
        emit: (k, x) => this.log(t, 'codex', k, x),
      });
      this.addUsage(t, 'codex', 'review', r.usage);
      t.codexThreadId = r.threadId ?? t.codexThreadId;
      return r.data;
    };
    const review = await this.structured(
      t,
      async (note) => {
        try {
          return await call(t.codexThreadId, note);
        } catch (e) {
          if (!(e instanceof AgentError) || e.kind !== 'cli' || !t.codexThreadId || this.cancelRequested) throw e;
          this.log(t, 'system', 'error', `Review-Sitzung konnte nicht fortgesetzt werden (${e.message}). Neuer Versuch mit frischer Sitzung.`);
          t.codexThreadId = undefined;
          return await call(undefined, note);
        }
      },
      validateReview,
    );
    round.review = review;
    const label = { accepted: 'Akzeptiert', needs_fix: 'Korrektur nötig', needs_user: 'Wartet auf Entscheidung' }[review.decision];
    if (review.decision !== 'needs_fix' || round.n >= t.maxFixRounds) this.d.onJournal?.(t, `${label}: ${(review.handoff_note || review.summary).slice(0, 600)}`);
    if (review.decision === 'accepted') t.phase = 'done';
    else if (review.decision === 'needs_user') {
      t.phase = 'await_user';
      t.userQuestion = review.user_question || review.summary || 'Codex benötigt eine Entscheidung von dir.';
    } else if (round.n >= t.maxFixRounds) {
      t.phase = 'await_user';
      t.userQuestion = `Die maximale Zahl von ${t.maxFixRounds} Korrekturrunden ist erreicht und Codex verlangt weiterhin Korrekturen. Der Ablauf wurde angehalten.`;
      this.log(t, 'system', 'error', t.userQuestion);
    } else this.beginRound(t, review.fix_task);
  }
}

export type { Plan, Round };
