// Gemeinsame Typen für Main- und Renderer-Prozess.

export type AgentName = 'codex' | 'claude' | 'system';

export interface AgentEvent {
  taskId: string;
  agent: AgentName;
  kind: 'text' | 'tool' | 'info' | 'error';
  text: string;
  ts: number;
}

export interface Settings {
  codexPath: string; // leer = automatisch suchen
  claudePath: string;
  gitPath: string;
  codexModel: string; // leer = Standard der CLI
  claudeModel: string;
  planTimeoutMin: number;
  implementTimeoutMin: number;
  reviewTimeoutMin: number;
  checkTimeoutMin: number;
  maxFixRounds: number;
  useWorktree: boolean;
  confirmPlan: boolean;
  pauseOnDenial: boolean; // bei verweigerten Freigaben anhalten statt nur an das Review melden
  claudeAllowedTools: string; // durch Leerzeichen getrennt, an --allowedTools
  allowApiKeyAuth: boolean; // API-Abrechnung nur nach ausdrücklicher Freigabe
  economyMode: boolean; // Sparmodus: Arbeitsregeln in den Prompts, schlanker Claude-Start
  codexEffort: string; // leer = Standard des Modells
  claudeEffort: string;
}

export const DEFAULT_SETTINGS: Settings = {
  codexPath: '',
  claudePath: '',
  gitPath: '',
  codexModel: '',
  claudeModel: '',
  planTimeoutMin: 10,
  implementTimeoutMin: 30,
  reviewTimeoutMin: 10,
  checkTimeoutMin: 10,
  maxFixRounds: 3,
  useWorktree: true,
  confirmPlan: true,
  pauseOnDenial: true,
  claudeAllowedTools: 'Read Edit Write Glob Grep Bash(npm test:*) Bash(npm run:*) Bash(git status:*) Bash(git diff:*)',
  allowApiKeyAuth: false,
  economyMode: true,
  codexEffort: '',
  claudeEffort: '',
};

export interface PlanCheck {
  name: string;
  command: string;
}

export interface Plan {
  goal: string;
  acceptance_criteria: string[];
  steps: string[];
  relevant_files: string[];
  checks: PlanCheck[];
  claude_task: string;
}

export interface CheckResult {
  name: string;
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  error?: string;
}

export type ReviewDecision = 'accepted' | 'needs_fix' | 'needs_user';

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  file: string;
  description: string;
}

export interface Review {
  decision: ReviewDecision;
  summary: string;
  findings: ReviewFinding[];
  fix_task: string;
  user_question: string;
  handoff_note: string; // kurzer Stand für das Projektjournal
}

export interface PermissionDenial {
  tool: string;
  detail: string;
}

export interface Usage {
  inputTokens: number; // einschließlich aus dem Cache gelesener Tokens
  outputTokens: number;
  cachedTokens?: number;
}

export type UsageStep = 'plan' | 'implement' | 'review';

export interface UsageEntry extends Usage {
  ts: number;
  agent: 'codex' | 'claude';
  step: UsageStep;
  round: number;
}

/** Von Claude Code gemeldete Kontingent-Auslastung (0–1). Codex liefert im exec-Modus nichts Vergleichbares. */
export interface Quota {
  ts: number;
  fiveHour?: { utilization: number; resetsAt: number };
  sevenDay?: { utilization: number; resetsAt: number };
  usingOverage: boolean;
}

export interface TaskOptions {
  profileId?: string;
  codexModel?: string;
  claudeModel?: string;
  codexEffort?: string;
  claudeEffort?: string;
}

export interface JournalEntry {
  ts: number;
  taskId?: string;
  text: string;
}

/** Projektprofil: Ordner, Vorgaben, Notizen und automatisch geführtes Journal. */
export interface Profile {
  id: string;
  name: string;
  projectDir: string;
  instructions: string; // dauerhafte Vorgaben für beide Agenten
  notes: string; // eigene Notizen, „wo stehen geblieben"
  codexModel: string;
  claudeModel: string;
  codexEffort: string;
  claudeEffort: string;
  journal: JournalEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface ModelCatalog {
  codex: { slug: string; name: string; efforts: string[]; defaultEffort: string }[];
  claude: { slug: string; name: string }[];
  claudeEfforts: string[];
  codexSource: string;
}

export interface Round {
  n: number; // 0 = erste Implementierung, ab 1 Korrekturrunden
  task: string; // Auftrag an Claude in dieser Runde
  claudeSummary?: string;
  denials?: PermissionDenial[];
  diff?: string;
  diffHash?: string;
  checks?: CheckResult[];
  review?: Review;
}

export type Phase = 'plan' | 'await_plan' | 'implement' | 'test' | 'review' | 'await_user' | 'done' | 'cancelled';
export type Status = 'idle' | 'running' | 'paused' | 'interrupted' | 'error' | 'waiting';
export type ErrorKind = 'auth' | 'limit' | 'timeout' | 'cancelled' | 'invalid_output' | 'cli' | 'not_found' | 'git';

export interface Task extends TaskOptions {
  id: string;
  prompt: string;
  projectDir: string;
  demo: boolean;
  createdAt: number;
  updatedAt: number;
  phase: Phase;
  status: Status;
  pauseRequested: boolean;
  plan?: Plan;
  rounds: Round[];
  maxFixRounds: number;
  workDir?: string;
  branch?: string;
  baseRef?: string;
  backupRef?: string;
  dirtyAtStart?: boolean;
  codexThreadId?: string;
  claudeSessionId?: string;
  extraAllowedTools: string[];
  error?: { kind: ErrorKind; message: string };
  userQuestion?: string; // Grund für await_user
  usage: { codex: Usage; claude: Usage };
  usageLog?: UsageEntry[];
}

export interface CliInfo {
  name: 'codex' | 'claude' | 'git';
  path: string | null;
  version: string | null;
  source: 'Einstellung' | 'PATH' | 'gebündelt' | null;
  error?: string;
}

export interface AuthInfo {
  loggedIn: boolean;
  method: string; // z. B. "ChatGPT", "claude.ai", "API-Schlüssel"
  subscription: boolean;
  detail?: string;
}

export interface EnvReport {
  clis: { codex: CliInfo; claude: CliInfo; git: CliInfo };
  auth: { codex: AuthInfo | null; claude: AuthInfo | null };
  conflicts: string[]; // nur Variablennamen, niemals Werte
}

export interface ConnTest {
  ok: boolean;
  message: string;
}

export interface GitState {
  isRepo: boolean;
  hasCommit: boolean;
  branch: string;
  dirtyFiles: string[];
  error?: string;
}

/** Stand der Veröffentlichung einer Aufgabe – Grundlage der Schritt-für-Schritt-Anzeige. */
export interface PublishState {
  inPlace: boolean; // ohne Worktree gearbeitet
  uncommitted: number; // noch nicht gesicherte Dateien im Arbeitsverzeichnis
  workBranch: string;
  projectBranch: string;
  merged: boolean; // Änderungen sind im Projekt-Branch enthalten
  pushed: boolean; // Projekt-Branch liegt so auf GitHub
  remote: string; // Adresse von origin ohne Zugangsdaten, leer = keine
  webUrl: string | null; // https://github.com/<owner>/<repo>
  workflows: string[];
}

export interface PipelineInfo {
  isRepo: boolean;
  branch: string;
  remote: string;
  webUrl: string | null;
  workflows: string[];
}

export type AnswerMode = 'fix' | 'accept' | 'allow_tools' | 'continue';

// Eng begrenzte IPC-Oberfläche.
export const INVOKE_CHANNELS = [
  'settings:get',
  'settings:set',
  'env:check',
  'env:install',
  'env:login',
  'env:test',
  'dialog:pickDir',
  'dialog:pickFile',
  'git:state',
  'task:list',
  'task:log',
  'task:create',
  'task:approvePlan',
  'task:pause',
  'task:resume',
  'task:cancel',
  'task:answer',
  'task:delete',
  'task:openTerminal',
  'shell:reveal',
  'profile:list',
  'profile:save',
  'profile:delete',
  'models:list',
  'quota:get',
  'publish:state',
  'publish:commit',
  'publish:merge',
  'publish:push',
  'publish:open',
  'publish:setRemote',
  'pipeline:info',
] as const;
export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

export const EVENT_CHANNELS = ['task:update', 'agent:event', 'setup:log', 'quota:update', 'profile:update'] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export interface Api {
  invoke<T = unknown>(channel: InvokeChannel, ...args: unknown[]): Promise<T>;
  on(channel: EventChannel, cb: (payload: any) => void): () => void;
  platform: string;
}
