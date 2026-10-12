// Karte: zeigt Aufgabe bzw. Projekt als aufklappbaren Baum – wer was gemacht hat und wo der Ablauf gerade steht.
import { useMemo, useState } from 'react';
import type { AgentEvent, Profile, Task } from '../shared/types';

export interface MapNode {
  id: string;
  label: string;
  sub?: string;
  tone: 'root' | 'codex' | 'claude' | 'test' | 'result' | 'leaf';
  status?: 'done' | 'run' | 'err' | 'wait';
  children?: MapNode[];
  collapsed?: boolean; // anfangs eingeklappt
  onClick?: () => void;
}

const W = 210;
const H = 42;
const GAP_X = 46;
const GAP_Y = 10;

interface Placed {
  node: MapNode;
  x: number;
  y: number;
  parent?: Placed;
  open: boolean;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function Mindmap({ root }: { root: MapNode }) {
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const { placed, width, height } = useMemo(() => {
    const out: Placed[] = [];
    let cursor = 0;
    let maxDepth = 0;
    const place = (node: MapNode, depth: number, parent?: Placed): Placed => {
      const open = !!node.children?.length && !!node.collapsed === toggled.has(node.id);
      const p: Placed = { node, x: depth * (W + GAP_X), y: 0, parent, open };
      maxDepth = Math.max(maxDepth, depth);
      out.push(p);
      if (open) {
        const kids = node.children!.map((c) => place(c, depth + 1, p));
        p.y = (kids[0].y + kids[kids.length - 1].y) / 2;
      } else {
        p.y = cursor;
        cursor += H + GAP_Y;
      }
      return p;
    };
    place(root, 0);
    return { placed: out, width: (maxDepth + 1) * (W + GAP_X) - GAP_X + 4, height: Math.max(cursor - GAP_Y, H) + 4 };
  }, [root, toggled]);

  return (
    <div className="map">
      <svg width={width} height={height} viewBox={`-2 -2 ${width} ${height}`} role="img" aria-label="Karte des Ablaufs">
        {placed.map(
          (p) =>
            p.parent && (
              <path
                key={`l-${p.node.id}`}
                className={`map-link ${p.node.status === 'run' ? 'run' : ''}`}
                d={`M ${p.parent.x + W} ${p.parent.y + H / 2} C ${p.parent.x + W + GAP_X / 2} ${p.parent.y + H / 2}, ${p.x - GAP_X / 2} ${p.y + H / 2}, ${p.x} ${p.y + H / 2}`}
              />
            ),
        )}
        {placed.map((p) => {
          const n = p.node;
          const kids = n.children?.length ?? 0;
          const clickable = kids > 0 || !!n.onClick;
          return (
            <g
              key={n.id}
              className={`map-node ${n.tone} ${n.status ?? ''} ${clickable ? 'click' : ''}`}
              transform={`translate(${p.x} ${p.y})`}
              onClick={() => {
                if (n.onClick) n.onClick();
                else if (kids) setToggled((s) => { const next = new Set(s); next.has(n.id) ? next.delete(n.id) : next.add(n.id); return next; });
              }}
            >
              <title>{n.sub ? `${n.label}\n${n.sub}` : n.label}</title>
              <rect width={W} height={H} rx={9} />
              <rect className="bar" width={4} height={H - 12} x={6} y={6} rx={2} />
              <text x={18} y={n.sub ? 17 : 26} className="lbl">
                {cut(n.label, kids ? 23 : 27)}
              </text>
              {n.sub && (
                <text x={18} y={32} className="sub">
                  {cut(n.sub, kids ? 29 : 34)}
                </text>
              )}
              {kids > 0 && (
                <text x={W - 12} y={26} className="chev" textAnchor="middle">
                  {p.open ? '–' : `+${kids}`}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function changedFiles(diff: string | undefined): string[] {
  if (!diff) return [];
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) out.add(m[2]);
  return [...out];
}

const leaves = (prefix: string, items: string[], tone: MapNode['tone'] = 'leaf'): MapNode[] => items.map((label, i) => ({ id: `${prefix}-${i}`, label, tone }));

/** Baum einer Aufgabe: Plan → Runden (Claude, Tests, Review) → Ergebnis; laufende Schritte pulsieren. */
export function taskTree(t: Task, events: AgentEvent[]): MapNode {
  const running = t.status === 'running';
  const bad = t.status === 'error';
  const live = (agent: 'codex' | 'claude') =>
    leaves(
      `live-${agent}`,
      events
        .filter((e) => e.agent === agent && e.kind === 'tool')
        .slice(-5)
        .map((e) => e.text),
    );
  const stepStatus = (phase: string, done: boolean): MapNode['status'] => (t.phase === phase ? (running ? 'run' : bad ? 'err' : 'wait') : done ? 'done' : undefined);

  const planKids: MapNode[] = [];
  if (t.plan) {
    planKids.push({ id: 'goal', label: 'Ziel', sub: t.plan.goal, tone: 'leaf' });
    planKids.push({ id: 'crit', label: `Akzeptanzkriterien (${t.plan.acceptance_criteria.length})`, tone: 'leaf', collapsed: true, children: leaves('crit', t.plan.acceptance_criteria) });
    planKids.push({ id: 'steps', label: `Arbeitsschritte (${t.plan.steps.length})`, tone: 'leaf', collapsed: true, children: leaves('steps', t.plan.steps) });
    planKids.push({ id: 'files', label: `Relevante Dateien (${t.plan.relevant_files.length})`, tone: 'leaf', collapsed: true, children: leaves('files', t.plan.relevant_files) });
  } else if (t.phase === 'plan' && running) planKids.push(...live('codex'));

  const kids: MapNode[] = [
    {
      id: 'plan',
      label: 'Codex · Plan',
      sub: t.phase === 'await_plan' ? 'wartet auf deine Bestätigung' : t.plan ? 'erstellt' : running ? 'wird erstellt…' : 'offen',
      tone: 'codex',
      status: t.phase === 'await_plan' ? 'wait' : stepStatus('plan', !!t.plan),
      children: planKids,
    },
  ];

  t.rounds.forEach((r, i) => {
    const last = i === t.rounds.length - 1;
    const files = changedFiles(r.diff);
    const implRunning = last && t.phase === 'implement';
    const impl: MapNode = {
      id: `impl-${i}`,
      label: 'Claude · Umsetzung',
      sub: r.claudeSummary !== undefined ? `${files.length} Datei(en) geändert` : implRunning && running ? 'arbeitet…' : 'offen',
      tone: 'claude',
      status: implRunning ? (running ? 'run' : bad ? 'err' : 'wait') : r.claudeSummary !== undefined ? 'done' : undefined,
      children: implRunning && running ? live('claude') : [...leaves(`f-${i}`, files), ...(r.denials ?? []).map((d, k) => ({ id: `den-${i}-${k}`, label: `verweigert: ${d.tool}`, sub: d.detail, tone: 'leaf' as const, status: 'err' as const }))],
    };
    const failed = (r.checks ?? []).filter((c) => c.exitCode !== 0).length;
    const tests: MapNode = {
      id: `test-${i}`,
      label: 'Tests',
      sub: r.checks ? (r.checks.length ? `${r.checks.length - failed} von ${r.checks.length} bestanden` : 'keine Prüfbefehle') : 'offen',
      tone: 'test',
      status: last && t.phase === 'test' ? (running ? 'run' : 'wait') : r.checks ? (failed ? 'err' : 'done') : undefined,
      children: (r.checks ?? []).map((c, k) => ({ id: `chk-${i}-${k}`, label: c.name, sub: c.exitCode === null ? (c.error ?? 'nicht ausgeführt') : `Exit-Code ${c.exitCode} · ${c.command}`, tone: 'leaf' as const, status: c.exitCode === 0 ? ('done' as const) : ('err' as const) })),
    };
    const dec = r.review?.decision;
    const review: MapNode = {
      id: `rev-${i}`,
      label: 'Codex · Review',
      sub: dec ? { accepted: 'akzeptiert', needs_fix: 'Korrektur erforderlich', needs_user: 'Nutzereingabe erforderlich' }[dec] : last && t.phase === 'review' && running ? 'prüft…' : 'offen',
      tone: 'codex',
      status: last && t.phase === 'review' ? (running ? 'run' : bad ? 'err' : 'wait') : dec === 'accepted' ? 'done' : dec ? 'err' : undefined,
      collapsed: (r.review?.findings.length ?? 0) > 4,
      children: (r.review?.findings ?? []).map((f, k) => ({ id: `fnd-${i}-${k}`, label: f.file || 'Befund', sub: f.description, tone: 'leaf' as const, status: f.severity === 'high' ? ('err' as const) : undefined })),
    };
    kids.push({
      id: `round-${i}`,
      label: i === 0 ? 'Implementierung' : r.n === t.rounds[i - 1].n ? 'Nachtrag' : `Korrekturrunde ${r.n}`,
      sub: r.task.replace(/\s+/g, ' '),
      tone: 'root',
      collapsed: !last && t.rounds.length > 2,
      children: [impl, tests, review],
    });
  });

  if (t.phase === 'done' || t.phase === 'cancelled' || t.phase === 'await_user')
    kids.push({
      id: 'result',
      label: t.phase === 'done' ? 'Ergebnis · akzeptiert' : t.phase === 'cancelled' ? 'Abgebrochen' : 'Wartet auf dich',
      sub: t.phase === 'await_user' ? t.userQuestion : t.branch ? `Branch ${t.branch}` : undefined,
      tone: 'result',
      status: t.phase === 'done' ? 'done' : t.phase === 'cancelled' ? 'err' : 'wait',
    });

  return { id: 'root', label: t.demo ? 'DEMO-Aufgabe' : 'Aufgabe', sub: t.prompt.replace(/\s+/g, ' '), tone: 'root', children: kids };
}

/** Baum eines Projekts: Profil → Aufgaben → Ziel, Runden, geänderte Dateien. */
export function projectTree(p: Profile, tasks: Task[], open: (id: string) => void): MapNode {
  const recent = tasks.slice(0, 14);
  return {
    id: 'root',
    label: p.name,
    sub: p.projectDir,
    tone: 'root',
    children: recent.map((t) => {
      const files = [...new Set(t.rounds.flatMap((r) => changedFiles(r.diff)))];
      const decisions = t.rounds.map((r) => r.review?.decision).filter(Boolean);
      const status: MapNode['status'] = t.phase === 'done' ? 'done' : t.status === 'running' ? 'run' : t.status === 'error' || t.phase === 'cancelled' ? 'err' : 'wait';
      return {
        id: t.id,
        label: t.prompt.replace(/\s+/g, ' '),
        sub: `${new Date(t.createdAt).toLocaleDateString('de-DE')} · ${t.phase === 'done' ? 'akzeptiert' : t.phase === 'cancelled' ? 'abgebrochen' : t.status === 'running' ? 'läuft' : 'offen'}`,
        tone: t.demo ? 'leaf' : 'claude',
        status,
        collapsed: true,
        children: [
          { id: `${t.id}-open`, label: 'Aufgabe öffnen →', tone: 'result' as const, onClick: () => open(t.id) },
          ...(t.plan ? [{ id: `${t.id}-goal`, label: 'Ziel', sub: t.plan.goal, tone: 'codex' as const }] : []),
          ...(t.rounds.length ? [{ id: `${t.id}-rounds`, label: `${t.rounds.length} Runde(n)`, sub: decisions.join(' → ') || 'noch kein Review', tone: 'codex' as const }] : []),
          ...(files.length ? [{ id: `${t.id}-files`, label: `Geänderte Dateien (${files.length})`, tone: 'leaf' as const, collapsed: true, children: leaves(`${t.id}-f`, files) }] : []),
        ],
      };
    }),
  };
}
