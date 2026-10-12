import type { AgentEvent, PermissionDenial, Quota, Usage } from '../../shared/types';

export type Emit = (kind: AgentEvent['kind'], text: string) => void;

export interface PlannerRequest {
  cwd: string;
  prompt: string;
  schema: object;
  model: string;
  effort?: string;
  timeoutMs: number;
  threadId?: string; // vorhandene Sitzung fortsetzen
  ephemeral?: boolean; // Sitzung nicht speichern (Verbindungstest)
  emit: Emit;
}

export interface PlannerResult {
  data: unknown; // geparstes JSON, noch nicht fachlich validiert
  threadId?: string;
  usage?: Usage;
}

/** Planung und Review – darf das Projekt nur lesen. */
export interface Planner {
  run(req: PlannerRequest): Promise<PlannerResult>;
}

export interface ImplementerRequest {
  cwd: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  sessionId?: string;
  allowedTools: string[];
  effort?: string;
  economy?: boolean; // ohne MCP-Server und Skills starten – deutlich kleinerer Grundkontext
  onQuota?: (q: Quota) => void;
  noPersist?: boolean;
  emit: Emit;
}

export interface ImplementerResult {
  summary: string;
  sessionId?: string;
  denials: PermissionDenial[];
  usage?: Usage;
}

/** Implementierung – der einzige Agent, der Projektdateien ändert. */
export interface Implementer {
  run(req: ImplementerRequest): Promise<ImplementerResult>;
}

export interface CliTarget {
  cmd: string;
  prefixArgs?: string[]; // für Tests: z. B. [mock-skript]
  env: NodeJS.ProcessEnv;
}
