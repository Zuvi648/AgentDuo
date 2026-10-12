// Test-Double für `codex exec --json`: gleiche Ereignisformate, Verhalten über Umgebungsvariablen.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const arg = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const state = process.env.MOCK_STATE;
const callsFile = path.join(state, 'codex-calls.json');
const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, 'utf8')) : [];
const prompt = fs.readFileSync(0, 'utf8');
const isReview = fs.readFileSync(arg('--output-schema'), 'utf8').includes('decision');
calls.push({ args, isReview, cwd: process.cwd(), prompt });
fs.writeFileSync(callsFile, JSON.stringify(calls));
const n = calls.filter((c) => c.isReview === isReview).length; // n-ter Aufruf dieser Art
const out = (o) => console.log(JSON.stringify(o));
const mode = process.env.MOCK_CODEX || '';

out({ type: 'thread.started', thread_id: 'thread-' + calls.length });
out({ type: 'turn.started' });
if (mode === 'limit') {
  out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at 5pm." } });
  process.exit(1);
}
if (mode === 'auth') {
  console.error('Error: Not logged in. Please run codex login.');
  process.exit(1);
}
out({ type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'ls' } });
out({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'ls', exit_code: 0 } });
let result;
if (!isReview) {
  result = {
    goal: 'Ziel',
    acceptance_criteria: ['Kriterium'],
    steps: ['Schritt'],
    relevant_files: ['a.txt'],
    checks: JSON.parse(process.env.MOCK_CHECKS || '[]'),
    claude_task: 'Lege Datei an',
  };
} else {
  const seq = (process.env.MOCK_REVIEWS || 'accepted').split(',');
  const decision = seq[Math.min(n - 1, seq.length - 1)];
  result = { decision, summary: 'Zusammenfassung ' + n, findings: decision === 'accepted' ? [] : [{ severity: 'high', file: 'a.txt', description: 'Mangel' }], fix_task: decision === 'needs_fix' ? 'Behebe Mangel ' + n : '', user_question: decision === 'needs_user' ? 'Welche Variante?' : '' };
}
let text = JSON.stringify(result);
if (mode === 'invalid_always' || (mode === 'invalid_once' && calls.length === 1)) text = 'das ist kein JSON';
if (mode === 'bad_shape_once' && calls.length === 1) text = JSON.stringify({ goal: 5 });
out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
fs.writeFileSync(arg('-o'), text);
out({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } });
