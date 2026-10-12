// Demo-Modus: simulierte Antworten ohne CLI-Aufrufe und ohne Dateiänderungen.
// Wird in der Oberfläche deutlich gekennzeichnet.
import type { Plan, Review } from '../../shared/types';
import type { Implementer, ImplementerRequest, ImplementerResult, Planner, PlannerRequest, PlannerResult } from './types';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DemoPlanner implements Planner {
  private reviews = 0;
  constructor(private delayMs = 600) {}

  async run(req: PlannerRequest): Promise<PlannerResult> {
    await wait(this.delayMs);
    const isReview = JSON.stringify(req.schema).includes('decision');
    if (!isReview) {
      req.emit('text', '[DEMO] Simulierter Plan – Codex wurde nicht aufgerufen.');
      const plan: Plan = {
        goal: '[DEMO] Beispielziel für die eingegebene Aufgabe',
        acceptance_criteria: ['[DEMO] Kriterium 1', '[DEMO] Kriterium 2'],
        steps: ['[DEMO] Schritt 1', '[DEMO] Schritt 2'],
        relevant_files: ['beispiel/datei.ts'],
        checks: [],
        claude_task: '[DEMO] Beispielauftrag. Im Demo-Modus werden keine Dateien geändert.',
      };
      return { data: plan };
    }
    this.reviews++;
    req.emit('text', '[DEMO] Simulierte Prüfung – Codex wurde nicht aufgerufen.');
    const review: Review =
      this.reviews === 1
        ? { decision: 'needs_fix', summary: '[DEMO] Simulierter Mangel, um eine Korrekturrunde zu zeigen.', findings: [{ severity: 'medium', file: 'beispiel/datei.ts', description: '[DEMO] Beispielbefund' }], fix_task: '[DEMO] Beispiel-Korrekturauftrag', user_question: '', handoff_note: '' }
        : { decision: 'accepted', summary: '[DEMO] Simuliert akzeptiert.', findings: [], fix_task: '', user_question: '', handoff_note: '[DEMO] Simulierter Stand.' };
    return { data: review };
  }
}

export class DemoImplementer implements Implementer {
  constructor(private delayMs = 600) {}

  async run(req: ImplementerRequest): Promise<ImplementerResult> {
    await wait(this.delayMs);
    req.emit('text', '[DEMO] Simulierte Implementierung – Claude Code wurde nicht aufgerufen.');
    return { summary: '[DEMO] Es wurden keine Dateien geändert.', denials: [] };
  }
}
