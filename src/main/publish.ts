// Veröffentlichen in einfachen Schritten: sichern (commit) → ins Projekt übernehmen (merge) → auf GitHub hochladen (push).
// Nichts davon passiert automatisch; jede Aktion wird vom Nutzer ausgelöst.
import fs from 'node:fs';
import path from 'node:path';
import type { PipelineInfo, PublishState, Task } from '../shared/types';
import type { Git } from './git';
import { AgentError } from './proc';

/** https://github.com/<owner>/<repo> aus einer origin-Adresse; null, wenn es kein GitHub-Remote ist. */
export function githubWebUrl(remote: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

export function isValidRemote(url: string): boolean {
  return githubWebUrl(url) !== null && !/\s/.test(url);
}

function workflows(dir: string): string[] {
  try {
    return fs.readdirSync(path.join(dir, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return [];
  }
}

export async function pipelineInfo(git: Git, dir: string): Promise<PipelineInfo> {
  const s = await git.state(dir);
  if (!s.isRepo) return { isRepo: false, branch: '', remote: '', webUrl: null, workflows: [] };
  const remote = await git.remote(dir);
  return { isRepo: true, branch: s.branch, remote, webUrl: githubWebUrl(remote), workflows: workflows(dir) };
}

function need(t: Task): { workDir: string } {
  if (t.demo) throw new AgentError('git', 'Im Demo-Modus gibt es nichts zu veröffentlichen.');
  if (!t.workDir) throw new AgentError('git', 'Für diese Aufgabe gibt es noch keine Änderungen.');
  if (t.status === 'running') throw new AgentError('git', 'Die Aufgabe läuft noch. Bitte warten, bis sie fertig ist.');
  return { workDir: t.workDir };
}

export async function publishState(git: Git, t: Task): Promise<PublishState> {
  const { workDir } = need(t);
  const inPlace = workDir === t.projectDir;
  const [uncommitted, workBranch, projectBranch, remote, workHead] = await Promise.all([git.uncommittedCount(workDir), git.currentBranch(workDir), git.currentBranch(t.projectDir), git.remote(t.projectDir), git.head(workDir)]);
  const merged = uncommitted === 0 && (inPlace || (await git.isAncestor(t.projectDir, workHead, 'HEAD')));
  const pushed = merged && !!remote && !!projectBranch && (await git.isPushed(t.projectDir, projectBranch));
  return { inPlace, uncommitted, workBranch, projectBranch, merged, pushed, remote, webUrl: githubWebUrl(remote), workflows: workflows(t.projectDir) };
}

export async function publishCommit(git: Git, t: Task, message: string): Promise<void> {
  const { workDir } = need(t);
  const msg = message.trim().slice(0, 2000);
  if (!msg) throw new AgentError('git', 'Bitte eine kurze Beschreibung der Änderung eingeben.');
  if ((await git.uncommittedCount(workDir)) === 0) throw new AgentError('git', 'Es gibt nichts zu sichern.');
  try {
    await git.commitAll(workDir, msg);
  } catch (e) {
    const m = (e as Error).message;
    throw new AgentError('git', /tell me who you are|user\.email|user\.name/i.test(m) ? 'Git kennt deinen Namen noch nicht. Bitte einmal im Terminal ausführen: git config --global user.name "Dein Name" und git config --global user.email "du@example.com"' : m);
  }
}

export async function publishMerge(git: Git, t: Task): Promise<void> {
  const { workDir } = need(t);
  if (workDir === t.projectDir) return;
  if ((await git.uncommittedCount(workDir)) > 0) throw new AgentError('git', 'Bitte zuerst die Änderungen sichern (Schritt 1).');
  await git.merge(t.projectDir, await git.currentBranch(workDir));
}

/** mode "project": den Projekt-Branch hochladen (löst die Pipeline aus). mode "pr": nur den Arbeits-Branch hochladen. */
export async function publishPush(git: Git, t: Task, mode: 'project' | 'pr'): Promise<string> {
  const { workDir } = need(t);
  if (!(await git.remote(t.projectDir))) throw new AgentError('git', 'Das Projekt ist noch nicht mit GitHub verbunden.');
  const dir = mode === 'pr' ? workDir : t.projectDir;
  const branch = await git.currentBranch(dir);
  if (!branch) throw new AgentError('git', 'Es ist kein Branch ausgecheckt.');
  try {
    await git.push(dir, branch);
  } catch (e) {
    const m = (e as Error).message;
    if (/could not read Username|Authentication failed|Permission denied|terminal prompts disabled|403/i.test(m)) throw new AgentError('auth', 'GitHub hat das Hochladen abgelehnt: Auf diesem Rechner ist keine GitHub-Anmeldung für Git eingerichtet. Am einfachsten: die GitHub CLI installieren und einmal „gh auth login“ ausführen.');
    if (/rejected|non-fast-forward|fetch first/i.test(m)) throw new AgentError('git', 'Auf GitHub gibt es neuere Änderungen als bei dir. Bitte zuerst im Terminal „git pull“ im Projektordner ausführen.');
    throw e;
  }
  return branch;
}
