// Electron-Hauptprozess: Fenster, eng begrenzte IPC und Verdrahtung der Backend-Module.
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { INVOKE_CHANNELS, type AnswerMode, type EnvReport, type InvokeChannel, type Profile, type Settings, type Task, type TaskOptions } from '../shared/types';
import { ClaudeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import { DemoImplementer, DemoPlanner } from './adapters/demo';
import { checkEnvironment, childEnv } from './env';
import { Git } from './git';
import { Orchestrator, type Runtime } from './orchestrator';
import { AgentError, ProcessManager } from './proc';
import { installCli, loginArgs, openTerminal, testConnection } from './setup';
import { addJournal, deleteProfile, modelCatalog, profileContext, saveProfile } from './profiles';
import { githubWebUrl, isValidRemote, pipelineInfo, publishCommit, publishMerge, publishPush, publishState } from './publish';
import { Store } from './store';

let win: BrowserWindow | null = null;
const send = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Agent Duo',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.setMenuBarVisibility(false);
  // Keine Navigation und keine neuen Fenster aus dem Renderer heraus.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

function main(): void {
  const store = new Store(path.join(app.getPath('userData'), 'data'));
  const pm = new ProcessManager(); // Agentenläufe – wird beim Abbruch vollständig beendet
  const aux = new ProcessManager(); // Statusabfragen, Installation, Verbindungstests

  /** Prüft CLIs und Anmeldung vor jedem Lauf; kein stiller Wechsel auf API-Abrechnung. */
  async function resolve(task: Task): Promise<Runtime> {
    const settings = store.getSettings();
    const env = await childEnv(settings, aux);
    const context = profileContext(store.getProfiles().find((p) => p.id === task.profileId));
    if (task.demo) return { planner: new DemoPlanner(), implementer: new DemoImplementer(), git: null, env, settings };
    const report = await checkEnvironment(settings, aux);
    const { codex, claude, git } = report.clis;
    if (!git.path) throw new AgentError('not_found', 'Git wurde nicht gefunden. Bitte installieren oder den Pfad in den Einstellungen setzen.');
    if (!codex.path) throw new AgentError('not_found', 'Codex CLI wurde nicht gefunden. Bitte unter „Einrichtung“ installieren oder den Pfad setzen.');
    if (!claude.path) throw new AgentError('not_found', 'Claude Code wurde nicht gefunden. Bitte unter „Einrichtung“ installieren oder den Pfad setzen.');
    for (const [label, a] of [['Codex', report.auth.codex], ['Claude Code', report.auth.claude]] as const) {
      if (!a?.loggedIn) throw new AgentError('auth', `${label} ist nicht angemeldet. Bitte unter „Einrichtung“ anmelden.`);
      if (!a.subscription && !settings.allowApiKeyAuth) throw new AgentError('auth', `${label} verwendet nicht die Abo-Anmeldung (${a.method}). Das könnte API-Kosten verursachen. Bitte mit dem Abo anmelden oder die API-Nutzung in den Einstellungen ausdrücklich erlauben.`);
    }
    return {
      planner: new CodexAdapter(pm, { cmd: codex.path, env }),
      implementer: new ClaudeAdapter(pm, { cmd: claude.path, env }),
      git: new Git(pm, git.path, env),
      env,
      settings,
      context,
    };
  }

  const orch = new Orchestrator({
    store,
    pm,
    worktreeRoot: path.join(app.getPath('userData'), 'worktrees'),
    resolve,
    onTask: (t) => send('task:update', t),
    onEvent: (e) => send('agent:event', e),
    onQuota: (q) => {
      store.saveQuota(q);
      send('quota:update', q);
    },
    onJournal: (t, text) => {
      const p = addJournal(store, t.profileId, t.id, `${t.prompt.slice(0, 80)} – ${text}`);
      if (p) send('profile:update', p);
    },
  });
  orch.init();

  const cliPath = async (which: 'codex' | 'claude'): Promise<string> => {
    const report: EnvReport = await checkEnvironment(store.getSettings(), aux);
    const p = report.clis[which].path;
    if (!p) throw new Error(`${which === 'codex' ? 'Codex CLI' : 'Claude Code'} wurde nicht gefunden.`);
    return p;
  };
  const which = (v: unknown): 'codex' | 'claude' => {
    if (v !== 'codex' && v !== 'claude') throw new Error('Ungültiges Ziel');
    return v;
  };
  const str = (v: unknown): string => {
    if (typeof v !== 'string') throw new Error('Ungültiges Argument');
    return v;
  };

  const gitFor = async (): Promise<Git> => {
    const settings = store.getSettings();
    const report = await checkEnvironment(settings, aux);
    if (!report.clis.git.path) throw new Error('Git wurde nicht gefunden.');
    return new Git(aux, report.clis.git.path, await childEnv(settings, aux));
  };
  const profileDir = (id: unknown): string => {
    const p = store.getProfiles().find((x) => x.id === str(id));
    if (!p) throw new Error('Profil nicht gefunden');
    return p.projectDir;
  };
  /** Rückfrage vor Aktionen, die das Projekt oder GitHub verändern. */
  const confirm = async (message: string, detail: string, ok: string): Promise<boolean> => {
    const r = await dialog.showMessageBox(win!, { type: 'question', buttons: [ok, 'Abbrechen'], defaultId: 0, cancelId: 1, message, detail });
    return r.response === 0;
  };

  const handlers: Record<InvokeChannel, (...args: unknown[]) => unknown> = {
    'settings:get': () => store.getSettings(),
    'settings:set': (s) => store.setSettings(s as Settings),
    'env:check': () => checkEnvironment(store.getSettings(), aux),
    'env:install': (w) => installCli(which(w), store.getSettings(), aux, (line) => send('setup:log', line)),
    'env:login': async (w) => {
      const target = which(w);
      openTerminal(loginArgs(target, await cliPath(target)), app.getPath('home'));
    },
    'env:test': async (w) => {
      const target = which(w);
      return testConnection(target, await cliPath(target), store.getSettings(), aux);
    },
    'dialog:pickDir': async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Projektordner wählen' });
      return r.canceled ? null : r.filePaths[0];
    },
    'dialog:pickFile': async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'treatPackageAsDirectory'], title: 'Programmdatei wählen' });
      return r.canceled ? null : r.filePaths[0];
    },
    'git:state': async (dir) => {
      const settings = store.getSettings();
      const report = await checkEnvironment(settings, aux);
      if (!report.clis.git.path) return { isRepo: false, hasCommit: false, branch: '', dirtyFiles: [], error: 'Git wurde nicht gefunden' };
      return new Git(aux, report.clis.git.path, await childEnv(settings, aux)).state(str(dir));
    },
    'task:list': () => orch.list(),
    'task:log': (id) => store.readLog(str(id)),
    'task:create': (prompt, dir, demo, opts) => {
      const o = (opts ?? {}) as Record<string, unknown>;
      const pick = (k: keyof TaskOptions) => (typeof o[k] === 'string' ? (o[k] as string).slice(0, 80) : undefined);
      return orch.create(str(prompt), str(dir), demo === true, store.getSettings().maxFixRounds, { profileId: pick('profileId'), codexModel: pick('codexModel'), claudeModel: pick('claudeModel'), codexEffort: pick('codexEffort'), claudeEffort: pick('claudeEffort') });
    },
    'task:approvePlan': (id, plan) => orch.approvePlan(str(id), plan),
    'task:pause': (id) => orch.pause(str(id)),
    'task:resume': (id) => orch.resume(str(id)),
    'task:cancel': (id) => orch.cancel(str(id)),
    'task:answer': (id, mode, text) => orch.answer(str(id), str(mode) as AnswerMode, typeof text === 'string' ? text : ''),
    'task:delete': (id) => orch.delete(str(id)),
    // Interaktive Fortsetzung der Claude-Sitzung im Terminal (z. B. für Freigaben).
    'task:openTerminal': async (id) => {
      const t = orch.get(str(id));
      if (!t.workDir) throw new Error('Für diese Aufgabe gibt es noch kein Arbeitsverzeichnis.');
      const claude = await cliPath('claude');
      openTerminal(t.claudeSessionId ? [claude, '--resume', t.claudeSessionId] : [claude], t.workDir);
    },
    'profile:list': () => store.getProfiles(),
    'profile:save': (p) => saveProfile(store, (p ?? {}) as Partial<Profile>),
    'profile:delete': (id) => deleteProfile(store, str(id)),
    'models:list': () => modelCatalog(),
    'quota:get': () => store.getQuota(),
    'publish:state': async (id) => publishState(await gitFor(), orch.get(str(id))),
    'publish:commit': async (id, message) => publishCommit(await gitFor(), orch.get(str(id)), str(message)),
    'publish:merge': async (id) => {
      const t = orch.get(str(id));
      if (!(await confirm('Änderungen in dein Projekt übernehmen?', `Die gesicherten Änderungen werden in den aktuellen Branch von\n${t.projectDir}\nübernommen (git merge). Bei Konflikten wird nichts verändert.`, 'Übernehmen'))) return false;
      await publishMerge(await gitFor(), t);
      return true;
    },
    'publish:push': async (id, mode) => {
      const t = orch.get(str(id));
      const m = mode === 'pr' ? 'pr' : 'project';
      const git = await gitFor();
      const remote = await git.remote(t.projectDir);
      if (!(await confirm('Auf GitHub hochladen?', `${m === 'pr' ? 'Der Arbeits-Branch' : 'Dein Projekt-Branch'} wird hochgeladen nach\n${remote || '(kein Remote)'}\n${m === 'project' ? 'Eine vorhandene Pipeline startet danach automatisch.' : 'Danach kannst du auf GitHub einen Pull Request öffnen.'}`, 'Hochladen'))) return null;
      return publishPush(git, t, m);
    },
    // Öffnet ausschließlich Seiten des verbundenen GitHub-Repositorys im Browser.
    'publish:open': async (dir, what, branch) => {
      const git = await gitFor();
      const d = str(dir);
      if (!store.getProfiles().some((p) => p.projectDir === d) && !orch.list().some((t) => t.projectDir === d)) throw new Error('Unbekannter Projektordner');
      const base = githubWebUrl(await git.remote(d));
      if (!base) throw new Error('Das Projekt ist nicht mit einem GitHub-Repository verbunden.');
      const b = typeof branch === 'string' && /^[\w./-]+$/.test(branch) ? branch : '';
      const url = what === 'actions' ? `${base}/actions` : what === 'pr' && b ? `${base}/compare/${b}?expand=1` : what === 'pages' ? `${base}/settings/pages` : base;
      await shell.openExternal(url);
    },
    'publish:setRemote': async (id, url) => {
      const u = str(url).trim();
      if (!isValidRemote(u)) throw new Error('Bitte die Adresse eines GitHub-Repositorys eingeben, z. B. https://github.com/name/projekt.git');
      await (await gitFor()).setRemote(profileDir(id), u);
    },
    'pipeline:info': async (id) => pipelineInfo(await gitFor(), profileDir(id)),
    'shell:reveal': (id) => {
      const t = orch.get(str(id));
      return shell.openPath(t.workDir ?? t.projectDir);
    },
  };

  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      // Nur das eigene Fenster mit der lokal geladenen Oberfläche darf IPC nutzen.
      if (!win || event.sender !== win.webContents || !event.senderFrame?.url.startsWith('file://')) throw new Error('Nicht erlaubt');
      return handlers[channel](...args);
    });
  }

  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
  app.on('before-quit', () => {
    pm.killAll();
    aux.killAll();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => win?.focus());
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(main);
}
