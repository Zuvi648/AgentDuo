// Git-Zugriffe: Zustand prüfen, Worktree anlegen, Sicherung bestehender Änderungen, Diff.
// Es gibt bewusst keine Funktion für push, merge, reset oder checkout.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { GitState } from '../shared/types';
import { AgentError, type ProcessManager } from './proc';

const MAX_DIFF_CHARS = 200_000;
const MAX_UNTRACKED_FILES = 40;

export class Git {
  constructor(
    private pm: ProcessManager,
    private gitPath: string,
    private env: NodeJS.ProcessEnv,
  ) {}

  private async git(cwd: string, args: string[], okCodes = [0], timeoutMs = 60000): Promise<string> {
    // Nie auf eine Passwortabfrage im Hintergrund warten – lieber verständlich scheitern.
    const r = await this.pm.run({ cmd: this.gitPath, args, cwd, env: { ...this.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs });
    if (r.cancelled) throw new AgentError('cancelled', 'Abgebrochen');
    if (r.code === null || !okCodes.includes(r.code)) throw new AgentError('git', `git ${args[0]} fehlgeschlagen (Code ${r.code}): ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  }

  async state(dir: string): Promise<GitState> {
    const none: GitState = { isRepo: false, hasCommit: false, branch: '', dirtyFiles: [] };
    try {
      if ((await this.git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return none;
    } catch (e) {
      return { ...none, error: 'Kein Git-Repository' };
    }
    let hasCommit = true;
    try {
      await this.git(dir, ['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasCommit = false;
    }
    const branch = (await this.git(dir, ['branch', '--show-current']).catch(() => '')).trim();
    const dirtyFiles = (await this.git(dir, ['status', '--porcelain']))
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3));
    return { isRepo: true, hasCommit, branch, dirtyFiles };
  }

  async head(dir: string): Promise<string> {
    return (await this.git(dir, ['rev-parse', 'HEAD'])).trim();
  }

  /** Legt einen separaten Worktree auf einem neuen Branch an. Das Hauptverzeichnis bleibt unberührt. */
  async addWorktree(repoDir: string, worktreeDir: string, branch: string): Promise<void> {
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    await this.git(repoDir, ['worktree', 'add', '-b', branch, worktreeDir, 'HEAD']);
  }

  /**
   * Sichert uncommittete Änderungen als Commit-Objekt unter refs/agent-duo/backup/<id>,
   * ohne Arbeitsverzeichnis oder Index zu verändern. Gibt den Commit zurück (oder null, wenn sauber).
   */
  async backupDirty(dir: string, id: string): Promise<string | null> {
    const sha = (await this.git(dir, ['stash', 'create', `agent-duo backup ${id}`])).trim();
    if (!sha) return null;
    await this.git(dir, ['update-ref', `refs/agent-duo/backup/${id}`, sha]);
    return sha;
  }

  /** Tatsächlicher Diff seit baseRef, einschließlich neuer (unversionierter) Dateien. */
  async diff(workDir: string, baseRef: string): Promise<{ diff: string; hash: string }> {
    let out = await this.git(workDir, ['diff', '--no-color', baseRef]);
    const untracked = (await this.git(workDir, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
    for (const f of untracked.slice(0, MAX_UNTRACKED_FILES)) {
      out += await this.git(workDir, ['diff', '--no-color', '--no-index', '--', '/dev/null', f], [0, 1]);
    }
    if (untracked.length > MAX_UNTRACKED_FILES) out += `\n[${untracked.length - MAX_UNTRACKED_FILES} weitere neue Dateien nicht angezeigt]\n`;
    const hash = createHash('sha256').update(out).digest('hex');
    if (out.length > MAX_DIFF_CHARS) out = out.slice(0, MAX_DIFF_CHARS) + `\n[Diff gekürzt: ${out.length - MAX_DIFF_CHARS} weitere Zeichen]\n`;
    return { diff: out, hash };
  }

  // --- Veröffentlichen: jede dieser Aktionen wird nur nach ausdrücklichem Klick des Nutzers aufgerufen ---

  async currentBranch(dir: string): Promise<string> {
    return (await this.git(dir, ['branch', '--show-current'])).trim();
  }

  async uncommittedCount(dir: string): Promise<number> {
    return (await this.git(dir, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
  }

  /** Adresse von origin, ohne eingebettete Zugangsdaten. Leer, wenn kein Remote eingerichtet ist. */
  async remote(dir: string): Promise<string> {
    const url = (await this.git(dir, ['remote', 'get-url', 'origin'], [0, 2])).trim();
    return url.replace(/\/\/[^/@]+@/, '//');
  }

  async setRemote(dir: string, url: string): Promise<void> {
    const has = (await this.git(dir, ['remote'])).split('\n').includes('origin');
    await this.git(dir, has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
  }

  async commitAll(dir: string, message: string): Promise<void> {
    await this.git(dir, ['add', '-A']);
    await this.git(dir, ['commit', '-m', message]);
  }

  async isAncestor(dir: string, ancestor: string, of: string): Promise<boolean> {
    const r = await this.pm.run({ cmd: this.gitPath, args: ['merge-base', '--is-ancestor', ancestor, of], cwd: dir, env: this.env, timeoutMs: 30000 });
    return r.code === 0;
  }

  /** Übernimmt einen Branch in den ausgecheckten Branch. Bei Konflikten wird sauber zurückgerollt. */
  async merge(dir: string, branch: string): Promise<void> {
    try {
      await this.git(dir, ['merge', '--no-edit', branch]);
    } catch (e) {
      await this.git(dir, ['merge', '--abort']).catch(() => {});
      throw new AgentError('git', `Übernehmen nicht möglich – es gibt Konflikte mit deinen eigenen Änderungen. Es wurde nichts verändert. (${(e as Error).message.slice(0, 300)})`);
    }
  }

  async push(dir: string, branch: string): Promise<void> {
    await this.git(dir, ['push', '-u', 'origin', branch], [0], 180000);
  }

  /** Liegt der Branch genau so auf dem Remote? (anhand des zuletzt bekannten Remote-Stands) */
  async isPushed(dir: string, branch: string): Promise<boolean> {
    const remoteSha = (await this.git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], [0, 1])).trim();
    return !!remoteSha && remoteSha === (await this.head(dir));
  }
}
