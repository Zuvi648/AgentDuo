// Echter End-to-End-Test mit den installierten CLIs und den vorhandenen Abo-Anmeldungen.
// Arbeitet ausschließlich in einem frisch angelegten Wegwerf-Repository.
// Aufruf: npm run e2e
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types';
import { ClaudeAdapter } from '../src/main/adapters/claude';
import { CodexAdapter } from '../src/main/adapters/codex';
import { PING_SCHEMA } from '../src/main/contracts';
import { checkEnvironment, childEnv } from '../src/main/env';
import { Git } from '../src/main/git';
import { Orchestrator } from '../src/main/orchestrator';
import { ProcessManager } from '../src/main/proc';
import { Store } from '../src/main/store';

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duo-e2e-')));
  const repo = path.join(root, 'testprojekt');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(repo, 'math.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(repo, 'test.js'), "const assert = require('assert');\nconst m = require('./math');\nassert.strictEqual(m.add(2, 3), 5);\nconsole.log('ok');\n");
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'NOTIZ.txt'), 'uncommittete Nutzeränderung\n');

  const settings: Settings = { ...DEFAULT_SETTINGS, confirmPlan: false, pauseOnDenial: false, maxFixRounds: 2, claudeAllowedTools: `${DEFAULT_SETTINGS.claudeAllowedTools} Bash(node test.js:*)` };
  const pm = new ProcessManager();
  const report = await checkEnvironment(settings, pm);
  console.log('CLIs:', report.clis.codex.version, '|', report.clis.claude.version, '|', report.clis.git.version);
  console.log('Anmeldung:', report.auth.codex?.method, '|', report.auth.claude?.method, '| Konflikte:', report.conflicts.join(',') || 'keine');
  if (!report.clis.codex.path || !report.clis.claude.path || !report.auth.codex?.subscription || !report.auth.claude?.subscription) throw new Error('BLOCKER: CLI fehlt oder keine Abo-Anmeldung');
  const env = await childEnv(settings, pm);
  // Für den Prüfbefehl `node test.js` muss node im PATH liegen (auf diesem Rechner nur projektlokal vorhanden).
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH}`;
  const planner = new CodexAdapter(pm, { cmd: report.clis.codex.path, env });
  const orch = new Orchestrator({
    store: new Store(path.join(root, 'data')),
    pm,
    worktreeRoot: path.join(root, 'worktrees'),
    resolve: async () => ({ planner, implementer: new ClaudeAdapter(pm, { cmd: report.clis.claude.path!, env }), git: new Git(pm, report.clis.git.path!, env), env, settings }),
    onTask: (t) => console.log(`  [Zustand] ${t.phase}/${t.status}`),
    onQuota: (q) => console.log(`  [Kontingent] 5h ${Math.round((q.fiveHour?.utilization ?? 0) * 100)} %, 7 Tage ${Math.round((q.sevenDay?.utilization ?? 0) * 100)} %`),
    onJournal: (_t, text) => console.log(`  [Journal] ${text}`),
    onEvent: (e) => console.log(`  [${e.agent}/${e.kind}] ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`),
  });
  const t = orch.create('Ergänze in math.js eine Funktion multiply(a, b) und erweitere test.js um eine Prüfung dafür. Der Test läuft mit "node test.js".', repo, false, settings.maxFixRounds);
  await orch.idle();

  const last = t.rounds.at(-1);
  console.log('\n=== Ergebnis ===');
  console.log('Phase/Status:', t.phase, t.status, t.error ? JSON.stringify(t.error) : '');
  console.log('Runden:', t.rounds.length, '| Entscheidungen:', t.rounds.map((r) => r.review?.decision).join(', '));
  console.log('Prüfungen:', JSON.stringify(last?.checks?.map((c) => ({ befehl: c.command, exit: c.exitCode }))));
  console.log('Diff enthält multiply:', !!last?.diff?.includes('multiply'));
  console.log('Token:', JSON.stringify(t.usage));
  console.log('Verbrauch je Schritt:', JSON.stringify(t.usageLog?.map((u) => `${u.agent}/${u.step}: ${u.inputTokens} ein (${u.cachedTokens ?? 0} Cache), ${u.outputTokens} aus`)));
  console.log('Projektordner unverändert:', git('status', '--porcelain').trim() === '?? NOTIZ.txt', '| math.js dort ohne multiply:', !fs.readFileSync(path.join(repo, 'math.js'), 'utf8').includes('multiply'));

  // Lesezugriff technisch erzwungen? Codex soll (frisch und in fortgesetzter Sitzung) eine Datei anlegen – das muss scheitern.
  for (const threadId of [undefined, t.codexThreadId]) {
    const marker = path.join(t.workDir ?? repo, `verboten-${threadId ? 'resume' : 'neu'}.txt`);
    await planner
      .run({ cwd: t.workDir ?? repo, prompt: `Sandbox-Test: Führe den Befehl "touch ${path.basename(marker)}" aus. Antworte mit ok=true, wenn die Datei danach existiert, sonst ok=false.`, schema: PING_SCHEMA, model: '', timeoutMs: 180_000, threadId, emit: () => {} })
      .then((r) => console.log(`Schreibversuch Codex (${threadId ? 'resume' : 'neu'}): Antwort ${JSON.stringify(r.data)}, Datei existiert: ${fs.existsSync(marker)}`))
      .catch((e) => console.log(`Schreibversuch Codex (${threadId ? 'resume' : 'neu'}): Fehler ${e.message}, Datei existiert: ${fs.existsSync(marker)}`));
  }
  console.log('Testverzeichnis:', root);
  process.exit(t.phase === 'done' ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(2);
});
