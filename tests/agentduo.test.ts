import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AgentEvent, type Settings, type Task } from '../src/shared/types';
import { ClaudeAdapter, claudeArgs, parseClaudeLine, splitTools } from '../src/main/adapters/claude';
import { CodexAdapter, codexArgs, parseCodexLine } from '../src/main/adapters/codex';
import { DemoImplementer, DemoPlanner } from '../src/main/adapters/demo';
import { tokenize } from '../src/main/checks';
import { validatePlan, validateReview } from '../src/main/contracts';
import { parseClaudeAuth, parseCodexAuth } from '../src/main/env';
import { Git } from '../src/main/git';
import { Orchestrator } from '../src/main/orchestrator';
import { classifyError, ProcessManager, redact } from '../src/main/proc';
import { addJournal, modelCatalog, profileContext, saveProfile } from '../src/main/profiles';
import { githubWebUrl, isValidRemote, pipelineInfo, publishCommit, publishMerge, publishPush, publishState } from '../src/main/publish';
import { Store } from '../src/main/store';

const MOCK_CODEX = path.join(__dirname, 'mocks', 'mock-codex.cjs');
const MOCK_CLAUDE = path.join(__dirname, 'mocks', 'mock-claude.cjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung im Test');
    await new Promise((r) => setTimeout(r, 25));
  }
};

interface Harness {
  root: string;
  repo: string;
  store: Store;
  pm: ProcessManager;
  orch: Orchestrator;
  env: Record<string, string>;
  settings: Settings;
  events: AgentEvent[];
  calls(which: 'codex' | 'claude'): any[];
  newOrchestrator(): Orchestrator;
}

const roots: string[] = [];
const pms: ProcessManager[] = [];

function harness(over: Partial<Settings> = {}, mockEnv: Record<string, string> = {}): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duo-t-')));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  fs.mkdirSync(repo);
  fs.mkdirSync(state);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const store = new Store(path.join(root, 'data'));
  const pm = new ProcessManager();
  pms.push(pm);
  const env: Record<string, string> = { MOCK_STATE: state, ...mockEnv };
  const settings: Settings = { ...DEFAULT_SETTINGS, confirmPlan: false, ...over };
  const events: AgentEvent[] = [];
  const newOrchestrator = () => {
    const o = new Orchestrator({
      store,
      pm,
      worktreeRoot: path.join(root, 'worktrees'),
      resolve: async () => {
        const childEnv = { ...process.env, ...env };
        return {
          planner: new CodexAdapter(pm, { cmd: process.execPath, prefixArgs: [MOCK_CODEX], env: childEnv }),
          implementer: new ClaudeAdapter(pm, { cmd: process.execPath, prefixArgs: [MOCK_CLAUDE], env: childEnv }),
          git: new Git(pm, 'git', childEnv),
          env: childEnv,
          settings,
          context: profileContext(store.getProfiles()[0]),
        };
      },
      onTask: () => {},
      onEvent: (e) => events.push(e),
      onQuota: (q) => store.saveQuota(q),
      onJournal: (t, text) => void addJournal(store, t.profileId, t.id, text),
    });
    o.init();
    return o;
  };
  const calls = (which: 'codex' | 'claude') => {
    const f = path.join(state, `${which}-calls.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  };
  return { root, repo, store, pm, orch: newOrchestrator(), env, settings, events, calls, newOrchestrator };
}

afterEach(() => {
  for (const pm of pms.splice(0)) pm.killAll();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('Ereignisparser und Hilfsfunktionen', () => {
  it('Codex: JSONL-Ereignisse', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"abc"}').threadId).toBe('abc');
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"hallo"}}').events).toEqual([{ kind: 'text', text: 'hallo' }]);
    expect(parseCodexLine('{"type":"item.started","item":{"type":"command_execution","command":"ls"}}').events[0]).toEqual({ kind: 'tool', text: '$ ls' });
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":15846,"output_tokens":19}}').usage).toEqual({ inputTokens: 15846, outputTokens: 19, cachedTokens: 0 });
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"kaputt"}}').error).toBe('kaputt');
    expect(parseCodexLine('kein json').events).toEqual([]);
    expect(parseCodexLine('{"type":"zukunft.unbekannt"}').events).toEqual([]);
  });

  it('Claude: stream-json-Ereignisse', () => {
    const a = parseClaudeLine('{"type":"assistant","session_id":"s1","message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"Bash","input":{"command":"npm test"}},{"type":"thinking","thinking":""}]}}');
    expect(a.sessionId).toBe('s1');
    expect(a.events).toEqual([{ kind: 'text', text: 'ok' }, { kind: 'tool', text: 'Bash: npm test' }]);
    expect(parseClaudeLine('{"type":"system","subtype":"permission_denied","tool_name":"Bash","message":"blockiert"}').denials).toEqual([{ tool: 'Bash', detail: 'blockiert' }]);
    expect(parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}').limitHit).toBeUndefined();
    expect(parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}').limitHit).toBe(true);
    const r = parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"fertig","usage":{"input_tokens":4,"cache_read_input_tokens":6,"output_tokens":9},"permission_denials":[{"tool_name":"Bash","tool_input":{"command":"x"}}]}');
    expect(r.result).toEqual({ isError: false, text: 'fertig', usage: { inputTokens: 10, outputTokens: 9, cachedTokens: 6 } });
    expect(r.denials[0].tool).toBe('Bash');
    expect(parseClaudeLine('{"type":"result","subtype":"error_max_turns"}').result?.isError).toBe(true);
    expect(parseClaudeLine('{{{').events).toEqual([]);
  });

  it('Argumente: Lesezugriff erzwungen, keine Bypass-Flags', () => {
    const fresh = codexArgs({ cwd: '/p', model: 'm1' }, 's.json', 'o.json');
    expect(fresh.slice(0, 3)).toEqual(['exec', '-s', 'read-only']);
    expect(fresh).toContain('--json');
    expect(fresh.slice(fresh.indexOf('-m'), fresh.indexOf('-m') + 2)).toEqual(['-m', 'm1']);
    const resume = codexArgs({ cwd: '/p', model: '', threadId: 't1' }, 's.json', 'o.json');
    expect(resume.slice(0, 5)).toEqual(['exec', 'resume', 't1', '-c', 'sandbox_mode="read-only"']);
    const c = claudeArgs({ model: '', sessionId: 's1', allowedTools: ['Read', 'Bash(npm test:*)'] });
    expect(c).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--resume', 's1']));
    expect(c[c.indexOf('--allowedTools') + 1]).toBe('Read,Bash(npm test:*)');
    for (const a of [...fresh, ...resume, ...c]) expect(a).not.toMatch(/dangerously|bypass|danger-full-access/i);
    expect(splitTools('Read Bash(npm test:*) Bash(git diff:*) Edit')).toEqual(['Read', 'Bash(npm test:*)', 'Bash(git diff:*)', 'Edit']);
  });

  it('Fehlerklassen, Schwärzung, Befehlszerlegung, Auth-Status', () => {
    expect(classifyError("You've hit your usage limit")).toBe('limit');
    expect(classifyError('Not logged in · Please run /login')).toBe('auth');
    expect(classifyError('Datei nicht gefunden')).toBeNull();
    const red = redact('key sk-ant-abc123def456ghi789 und Authorization: Bearer abcdefghijklmnopqrstuvwxyz und api_key="geheimgeheim1"');
    expect(red).not.toMatch(/abc123def456|abcdefghijklmnop|geheimgeheim1/);
    expect(tokenize('npm run test -- --grep "zwei worte"')).toEqual(['npm', 'run', 'test', '--', '--grep', 'zwei worte']);
    expect(() => tokenize('npm test && rm -rf /')).toThrow();
    expect(() => tokenize('echo $(whoami)')).toThrow();
    expect(parseCodexAuth('Logged in using ChatGPT')).toMatchObject({ loggedIn: true, subscription: true });
    expect(parseCodexAuth('Logged in using an API key - sk-***')).toMatchObject({ loggedIn: true, subscription: false });
    expect(parseCodexAuth('Not logged in')).toMatchObject({ loggedIn: false });
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}')).toMatchObject({ loggedIn: true, subscription: true });
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}')).toMatchObject({ loggedIn: true, subscription: false });
    expect(parseClaudeAuth('{"loggedIn":false,"authMethod":"none"}')).toMatchObject({ loggedIn: false });
  });

  it('Strukturierte Antworten werden validiert', () => {
    expect(() => validatePlan({ goal: 5 })).toThrow(/ungültig/);
    expect(() => validateReview({ decision: 'vielleicht', summary: '', findings: [] })).toThrow(/Entscheidung/);
    expect(() => validateReview({ decision: 'needs_fix', summary: '', findings: [], fix_task: ' ' })).toThrow(/fix_task/);
  });
});

describe('Orchestrierung mit Mock-CLIs', () => {
  it('vollständiger Ablauf mit Korrekturrunde im Worktree; Nutzeränderungen bleiben unberührt', async () => {
    const h = harness({}, { MOCK_REVIEWS: 'needs_fix,accepted', MOCK_CHECKS: JSON.stringify([{ name: 'Version', command: 'git --version' }, { name: 'Fehlschlag', command: 'git kein-solcher-befehl' }]) });
    fs.writeFileSync(path.join(h.repo, 'a.txt'), 'vom nutzer geändert\n');
    fs.writeFileSync(path.join(h.repo, 'neu-vom-nutzer.txt'), 'x\n');
    const headBefore = git(h.repo, 'rev-parse', 'HEAD');
    const t = h.orch.create('Baue etwas', h.repo, false, 3);
    await h.orch.idle();

    expect(t.phase).toBe('done');
    expect(t.status).toBe('idle');
    expect(t.rounds.map((r) => r.review?.decision)).toEqual(['needs_fix', 'accepted']);
    expect(t.rounds[1].task).toBe('Behebe Mangel 1');
    expect(t.workDir).not.toBe(h.repo);
    expect(t.dirtyAtStart).toBe(true);
    // Echter Diff und echte Exit-Codes
    expect(t.rounds[0].diff).toContain('impl-1.txt');
    expect(t.rounds[1].diff).toContain('impl-2.txt');
    expect(t.rounds[0].checks?.map((c) => c.exitCode)).toEqual([0, 1]);
    // Review erhält Diff, Zusammenfassung und Exit-Codes
    const review = h.calls('codex').find((c) => c.isReview);
    expect(review.prompt).toContain('impl-1.txt');
    expect(review.prompt).toContain('Zusammenfassung 1');
    expect(review.prompt).toContain('Exit-Code: 1');
    expect(review.cwd).toBe(t.workDir);
    // Codex lief ausnahmslos mit erzwungenem Lesezugriff, zweites Review setzt die Sitzung fort
    for (const c of h.calls('codex')) expect(c.args.join(' ')).toMatch(/-s read-only|sandbox_mode="read-only"/);
    expect(h.calls('codex')[2].args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-2']);
    // Claude arbeitete nur im Worktree und setzte die Sitzung fort
    for (const c of h.calls('claude')) expect(c.cwd).toBe(t.workDir);
    expect(h.calls('claude')[1].args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
    // Projektordner: Nutzeränderungen erhalten, nichts committet, keine Agentendateien
    expect(fs.readFileSync(path.join(h.repo, 'a.txt'), 'utf8')).toBe('vom nutzer geändert\n');
    expect(fs.existsSync(path.join(h.repo, 'neu-vom-nutzer.txt'))).toBe(true);
    expect(fs.existsSync(path.join(h.repo, 'impl-1.txt'))).toBe(false);
    expect(git(h.repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(t.usage.codex.inputTokens).toBe(300);
    // Persistiert
    expect(h.store.loadTasks()[0].phase).toBe('done');
    expect(h.store.readLog(t.id).length).toBeGreaterThan(5);
  });

  it('ohne Worktree: bestehende Änderungen werden gesichert und bleiben erhalten', async () => {
    const h = harness({ useWorktree: false });
    fs.writeFileSync(path.join(h.repo, 'a.txt'), 'vom nutzer geändert\n');
    const t = h.orch.create('Baue etwas', h.repo, false, 3);
    await h.orch.idle();
    expect(t.phase).toBe('done');
    expect(t.backupRef).toBe(`refs/agent-duo/backup/${t.id}`);
    expect(git(h.repo, 'show', `${t.backupRef}:a.txt`)).toBe('vom nutzer geändert\n');
    expect(fs.readFileSync(path.join(h.repo, 'a.txt'), 'utf8')).toBe('vom nutzer geändert\n');
    // Diff zeigt nur die Agentenänderung, nicht die des Nutzers
    expect(t.rounds[0].diff).toContain('impl-1.txt');
    expect(t.rounds[0].diff).not.toContain('vom nutzer geändert');
  });

  it('Plan-Bestätigung: wartet, übernimmt den bearbeiteten Plan', async () => {
    const h = harness({ confirmPlan: true });
    const t = h.orch.create('Baue etwas', h.repo, false, 3);
    await h.orch.idle();
    expect(t.phase).toBe('await_plan');
    expect(t.status).toBe('waiting');
    expect(h.calls('claude')).toHaveLength(0);
    expect(() => h.orch.approvePlan(t.id, { goal: '' })).toThrow();
    h.orch.approvePlan(t.id, { ...t.plan!, claude_task: 'Vom Nutzer bearbeiteter Auftrag' });
    await h.orch.idle();
    expect(t.phase).toBe('done');
    expect(h.calls('claude')[0].prompt).toContain('Vom Nutzer bearbeiteter Auftrag');
  });

  it('fehlerhafte strukturierte Antwort: ein erneuter Versuch, danach verständlicher Fehler', async () => {
    const ok = harness({}, { MOCK_CODEX: 'invalid_once' });
    const t1 = ok.orch.create('x', ok.repo, false, 3);
    await ok.orch.idle();
    expect(t1.phase).toBe('done');
    expect(ok.calls('codex')[1].prompt).toContain('vorherige Antwort war ungültig');

    const shape = harness({}, { MOCK_CODEX: 'bad_shape_once' });
    const t2 = shape.orch.create('x', shape.repo, false, 3);
    await shape.orch.idle();
    expect(t2.phase).toBe('done');

    const bad = harness({}, { MOCK_CODEX: 'invalid_always' });
    const t3 = bad.orch.create('x', bad.repo, false, 3);
    await bad.orch.idle();
    expect(t3.status).toBe('error');
    expect(t3.error?.kind).toBe('invalid_output');
    expect(bad.calls('codex')).toHaveLength(2); // genau ein erneuter Versuch
    expect(bad.calls('claude')).toHaveLength(0);
  });

  it('Nutzungslimit und Login-Fehler stoppen ohne Wiederholung und ohne Anbieterwechsel', async () => {
    const lim = harness({}, { MOCK_CODEX: 'limit' });
    const t1 = lim.orch.create('x', lim.repo, false, 3);
    await lim.orch.idle();
    expect(t1.error?.kind).toBe('limit');
    expect(lim.calls('codex')).toHaveLength(1);
    expect(lim.calls('claude')).toHaveLength(0);

    const auth = harness({}, { MOCK_CODEX: 'auth' });
    const t2 = auth.orch.create('x', auth.repo, false, 3);
    await auth.orch.idle();
    expect(t2.error?.kind).toBe('auth');

    const cAuth = harness({}, { MOCK_CLAUDE: 'auth' });
    const t3 = cAuth.orch.create('x', cAuth.repo, false, 3);
    await cAuth.orch.idle();
    expect(t3.status).toBe('error');
    expect(t3.error?.kind).toBe('auth');
    expect(t3.phase).toBe('implement');
    expect(cAuth.calls('claude')).toHaveLength(1);

    const cLim = harness({}, { MOCK_CLAUDE: 'limit' });
    const t4 = cLim.orch.create('x', cLim.repo, false, 3);
    await cLim.orch.idle();
    expect(t4.error?.kind).toBe('limit');
    // Nach behobenem Problem lässt sich derselbe Schritt manuell fortsetzen
    cLim.env.MOCK_CLAUDE = '';
    cLim.orch.resume(t4.id);
    await cLim.orch.idle();
    expect(t4.phase).toBe('done');
  });

  it('Abbruch beendet auch Enkelprozesse und erhält entstandene Änderungen', async () => {
    const h = harness({}, { MOCK_CLAUDE: 'hang' });
    const t = h.orch.create('x', h.repo, false, 3);
    const pidFile = path.join(h.root, 'state', 'grandchild.pid');
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    h.orch.cancel(t.id);
    await h.orch.idle();
    expect(t.phase).toBe('cancelled');
    await until(() => !alive(pid), 5000);
    expect(h.pm.activeCount).toBe(0);
    expect(fs.readFileSync(path.join(t.workDir!, 'teilweise.txt'), 'utf8')).toContain('vor dem Abbruch');
    expect(() => h.orch.resume(t.id)).toThrow();
  });

  it('Zeitlimit beendet den Prozess und meldet einen Timeout', async () => {
    const h = harness({}, { MOCK_CLAUDE: 'hang' });
    h.settings.implementTimeoutMin = 0.01; // 0,6 s
    const t = h.orch.create('x', h.repo, false, 3);
    await h.orch.idle();
    expect(t.error?.kind).toBe('timeout');
    expect(h.pm.activeCount).toBe(0);
  });

  it('Neustart: unterbrochene Aufgabe ist sichtbar und wird nicht automatisch fortgesetzt', async () => {
    const h = harness({}, { MOCK_CLAUDE: 'hang' });
    const t = h.orch.create('x', h.repo, false, 3);
    await until(() => h.calls('claude').length === 1);
    // App „stürzt ab“: Zustand liegt als running auf der Platte
    const onDisk = h.store.loadTasks()[0];
    expect(onDisk.status).toBe('running');
    h.pm.killAll();
    await h.orch.idle();
    h.store.saveTask({ ...onDisk });

    const restarted = h.newOrchestrator();
    const again = restarted.list()[0];
    expect(again.id).toBe(t.id);
    expect(again.status).toBe('interrupted');
    expect(again.phase).toBe('implement');
    await new Promise((r) => setTimeout(r, 200));
    expect(h.calls('claude')).toHaveLength(1); // kein automatischer Neustart
    // Fortsetzen nur auf ausdrücklichen Wunsch
    h.env.MOCK_CLAUDE = '';
    restarted.resume(again.id);
    await restarted.idle();
    expect(again.phase).toBe('done');
    expect(again.workDir).toBe(onDisk.workDir); // derselbe Worktree, kein zweiter
  });

  it('maximale Korrekturrunden und fehlender Fortschritt halten den Ablauf an', async () => {
    const max = harness({}, { MOCK_REVIEWS: 'needs_fix' });
    const t1 = max.orch.create('x', max.repo, false, 2);
    await max.orch.idle();
    expect(t1.phase).toBe('await_user');
    expect(t1.userQuestion).toMatch(/maximale Zahl von 2/);
    expect(max.calls('claude')).toHaveLength(3); // 1 Implementierung + 2 Korrekturen
    expect(max.calls('codex').filter((c) => c.isReview)).toHaveLength(3);

    const stuck = harness({}, { MOCK_REVIEWS: 'needs_fix', MOCK_CLAUDE: ',noop' });
    const t2 = stuck.orch.create('x', stuck.repo, false, 3);
    await stuck.orch.idle();
    expect(t2.phase).toBe('await_user');
    expect(t2.userQuestion).toMatch(/Kein Fortschritt/);
    expect(stuck.calls('claude')).toHaveLength(2);
    // Nutzer kann das Ergebnis trotzdem übernehmen
    stuck.orch.answer(t2.id, 'accept', '');
    expect(t2.phase).toBe('done');
  });

  it('verweigerte Freigaben halten an; Freigabe gilt nur für diese Aufgabe', async () => {
    const h = harness({}, { MOCK_CLAUDE: 'denied,' });
    const t = h.orch.create('x', h.repo, false, 3);
    await h.orch.idle();
    expect(t.phase).toBe('await_user');
    expect(t.rounds[0].denials).toEqual([{ tool: 'Bash', detail: 'npm install wurde nicht freigegeben' }]);
    expect(h.calls('codex').filter((c) => c.isReview)).toHaveLength(0);
    h.orch.answer(t.id, 'allow_tools', '');
    await h.orch.idle();
    expect(t.phase).toBe('done');
    const second = h.calls('claude')[1].args;
    expect(second[second.indexOf('--allowedTools') + 1].split(',')).toContain('Bash');
    expect(h.settings.claudeAllowedTools).not.toMatch(/(^| )Bash( |$)/);
  });

  it('needs_user: Frage wird gezeigt, Antwort geht als Auftrag an Claude', async () => {
    const h = harness({}, { MOCK_REVIEWS: 'needs_user,accepted' });
    const t = h.orch.create('x', h.repo, false, 3);
    await h.orch.idle();
    expect(t.phase).toBe('await_user');
    expect(t.userQuestion).toBe('Welche Variante?');
    h.orch.answer(t.id, 'fix', 'Variante B bitte');
    await h.orch.idle();
    expect(t.phase).toBe('done');
    expect(h.calls('claude')[1].prompt).toContain('Variante B bitte');
  });

  it('Pause nach aktuellem Schritt, Fortsetzen, nur ein Lauf gleichzeitig', async () => {
    const h = harness();
    const t = h.orch.create('x', h.repo, false, 3);
    expect(() => h.orch.create('y', h.repo, false, 3)).toThrow(/läuft bereits/);
    h.orch.pause(t.id);
    await h.orch.idle();
    expect(t.status).toBe('paused');
    expect(t.phase).toBe('implement'); // Plan abgeschlossen, Implementierung nicht begonnen
    expect(h.calls('claude')).toHaveLength(0);
    h.orch.resume(t.id);
    await h.orch.idle();
    expect(t.phase).toBe('done');
  });

  it('kein Git-Repository: verständlicher Fehler, nichts wird angelegt', async () => {
    const h = harness();
    const plain = path.join(h.root, 'plain');
    fs.mkdirSync(plain);
    const t = h.orch.create('x', plain, false, 3);
    await h.orch.idle();
    expect(t.error?.kind).toBe('git');
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
    expect(h.calls('codex')).toHaveLength(0);
  });

  it('Demo-Modus ruft keine CLI auf und ändert keine Dateien', async () => {
    const h = harness();
    const store = h.store;
    const o = new Orchestrator({
      store,
      pm: h.pm,
      worktreeRoot: path.join(h.root, 'wt'),
      resolve: async () => ({ planner: new DemoPlanner(1), implementer: new DemoImplementer(1), git: null, env: process.env, settings: h.settings }),
      onTask: () => {},
      onEvent: () => {},
    });
    const t: Task = o.create('Demo', '', true, 3);
    await o.idle();
    expect(t.phase).toBe('done');
    expect(t.rounds).toHaveLength(2);
    expect(t.rounds[0].diff).toMatch(/Demo-Modus/);
    expect(h.calls('codex')).toHaveLength(0);
  });

  it('Modellwahl, Denkaufwand und Sparmodus landen in den CLI-Argumenten und Prompts', async () => {
    const h = harness({ economyMode: true, codexModel: 'global-codex' });
    const t = h.orch.create('x', h.repo, false, 3, { codexModel: 'gpt-test', codexEffort: 'low', claudeModel: 'sonnet', claudeEffort: 'medium' });
    await h.orch.idle();
    expect(t.phase).toBe('done');
    const cx = h.calls('codex')[0];
    expect(cx.args.join(' ')).toContain('-m gpt-test');
    expect(cx.args.join(' ')).toContain('-c model_reasoning_effort="low"');
    expect(cx.prompt).toContain('Arbeitsregeln');
    const cl = h.calls('claude')[0];
    expect(cl.args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'medium', '--strict-mcp-config', '--disable-slash-commands']));
    expect(cl.prompt).toContain('Nicht das ganze Projekt lesen');
    expect(h.calls('codex')[1].prompt).toContain('führe die Prüfungen nicht erneut aus');
    // Verbrauch je Schritt
    expect(t.usageLog?.map((u) => `${u.agent}:${u.step}`)).toEqual(['codex:plan', 'claude:implement', 'codex:review']);

    const off = harness({ economyMode: false });
    off.orch.create('x', off.repo, false, 3);
    await off.orch.idle();
    expect(off.calls('claude')[0].args).not.toContain('--strict-mcp-config');
    expect(off.calls('claude')[0].prompt).not.toContain('Arbeitsregeln');
    expect(off.calls('codex')[0].args.join(' ')).not.toContain('model_reasoning_effort');
    expect(claudeArgs({ model: '', allowedTools: [], effort: 'low; rm -rf' }).join(' ')).not.toContain('--effort');
  });

  it('Kontingent: Auslastung wird gelesen, Zusatznutzung stoppt den Lauf', () => {
    const q = parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.17,"resetsAt":1791828600},"seven_day":{"utilization":0.05,"resetsAt":1792162800}}}}');
    expect(q.quota).toMatchObject({ fiveHour: { utilization: 0.17, resetsAt: 1791828600 }, sevenDay: { utilization: 0.05 }, usingOverage: false });
    expect(q.limitHit).toBeUndefined();
    expect(parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","isUsingOverage":true}}').limitHit).toBe(true);
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":5}}').usage).toEqual({ inputTokens: 100, outputTokens: 5, cachedTokens: 60 });
  });

  it('Profil: Vorgaben und Notizen gehen an beide Agenten, das Journal wird automatisch geführt', async () => {
    const h = harness();
    const p = saveProfile(h.store, { name: 'Testprojekt', projectDir: h.repo, instructions: 'Immer TypeScript strict.', notes: 'Stehen geblieben bei Modul B.' });
    expect(saveProfile(h.store, { id: p.id, notes: 'Neu' }).instructions).toBe('Immer TypeScript strict.');
    saveProfile(h.store, { id: p.id, notes: 'Stehen geblieben bei Modul B.' });
    const t = h.orch.create('Baue Modul B fertig', h.repo, false, 3, { profileId: p.id });
    await h.orch.idle();
    expect(t.phase).toBe('done');
    for (const c of [h.calls('codex')[0], h.calls('claude')[0], h.calls('codex')[1]]) {
      expect(c.prompt).toContain('Immer TypeScript strict.');
      expect(c.prompt).toContain('Stehen geblieben bei Modul B.');
    }
    const after = h.store.getProfiles()[0];
    expect(after.journal).toHaveLength(1);
    expect(after.journal[0]).toMatchObject({ taskId: t.id });
    expect(after.journal[0].text).toMatch(/^Akzeptiert: /);
    // Kontext bleibt begrenzt, damit das Profil nicht dauerhaft Kontingent frisst
    expect(profileContext({ ...after, notes: 'x'.repeat(10000) }).length).toBeLessThan(3100);
    expect(profileContext(undefined)).toBe('');
    expect(modelCatalog().claude.map((m) => m.slug)).toContain('sonnet');
  });

  it('Veröffentlichen: sichern, ins Projekt übernehmen, hochladen – jeder Schritt einzeln', async () => {
    const h = harness();
    const origin = path.join(h.root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    const g = new Git(h.pm, 'git', process.env);
    await g.setRemote(h.repo, origin);
    const branch = git(h.repo, 'branch', '--show-current').trim();
    git(h.repo, 'push', '-q', '-u', 'origin', branch);
    fs.mkdirSync(path.join(h.repo, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(h.repo, '.github', 'workflows', 'deploy.yml'), 'name: Deploy\n');
    git(h.repo, 'add', '.');
    git(h.repo, 'commit', '-q', '-m', 'pipeline');

    const t = h.orch.create('x', h.repo, false, 3);
    await h.orch.idle();
    expect(t.phase).toBe('done');
    // Der Ablauf selbst hat nichts committet, gemergt oder hochgeladen
    let s = await publishState(g, t);
    expect(s).toMatchObject({ inPlace: false, uncommitted: 1, merged: false, pushed: false, remote: origin, webUrl: null, workflows: ['deploy.yml'], projectBranch: branch });
    await expect(publishMerge(g, t)).rejects.toThrow(/zuerst die Änderungen sichern/);
    await expect(publishCommit(g, t, '  ')).rejects.toThrow(/Beschreibung/);

    await publishCommit(g, t, 'Agent-Änderung');
    s = await publishState(g, t);
    expect(s).toMatchObject({ uncommitted: 0, merged: false, pushed: false });
    expect(fs.existsSync(path.join(h.repo, 'impl-1.txt'))).toBe(false);

    await publishMerge(g, t);
    s = await publishState(g, t);
    expect(s).toMatchObject({ merged: true, pushed: false });
    expect(fs.existsSync(path.join(h.repo, 'impl-1.txt'))).toBe(true);
    expect(execFileSync('git', ['--git-dir', origin, 'log', '--oneline', branch], { encoding: 'utf8' })).not.toContain('Agent-Änderung');

    expect(await publishPush(g, t, 'project')).toBe(branch);
    expect((await publishState(g, t)).pushed).toBe(true);
    expect(execFileSync('git', ['--git-dir', origin, 'log', '--oneline', branch], { encoding: 'utf8' })).toContain('Agent-Änderung');
    // Variante Pull Request: nur der Arbeits-Branch wird hochgeladen
    expect(await publishPush(g, t, 'pr')).toBe(t.branch);
    expect(execFileSync('git', ['--git-dir', origin, 'branch', '--list'], { encoding: 'utf8' })).toContain(t.branch!);
    expect(await pipelineInfo(g, h.repo)).toMatchObject({ isRepo: true, branch, workflows: ['deploy.yml'] });
  });

  it('Veröffentlichen: Konflikt beim Übernehmen verändert nichts; Adressen werden geprüft', async () => {
    const h = harness();
    const g = new Git(h.pm, 'git', process.env);
    const t = h.orch.create('x', h.repo, false, 3);
    await h.orch.idle();
    await publishCommit(g, t, 'Agent-Änderung');
    // Der Nutzer hat inzwischen dieselbe Datei im Projekt angelegt
    fs.writeFileSync(path.join(h.repo, 'impl-1.txt'), 'vom Nutzer\n');
    await expect(publishMerge(g, t)).rejects.toThrow(/Es wurde nichts verändert/);
    expect(fs.readFileSync(path.join(h.repo, 'impl-1.txt'), 'utf8')).toBe('vom Nutzer\n');
    await expect(publishPush(g, t, 'project')).rejects.toThrow(/noch nicht mit GitHub verbunden/);

    expect(githubWebUrl('https://github.com/acme/tool.git')).toBe('https://github.com/acme/tool');
    expect(githubWebUrl('git@github.com:acme/tool.git')).toBe('https://github.com/acme/tool');
    expect(githubWebUrl('https://user:token@evil.example/x/y')).toBeNull();
    expect(isValidRemote('https://github.com/acme/tool')).toBe(true);
    expect(isValidRemote('--upload-pack=touch x')).toBe(false);
    expect(isValidRemote('/lokaler/pfad')).toBe(false);
    await g.setRemote(h.repo, 'https://nutzer:geheim123@github.com/acme/tool.git');
    expect(await g.remote(h.repo)).toBe('https://github.com/acme/tool.git');
  });
});

