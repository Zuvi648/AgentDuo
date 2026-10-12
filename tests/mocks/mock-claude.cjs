// Test-Double für `claude -p --output-format stream-json`.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const state = process.env.MOCK_STATE;
const callsFile = path.join(state, 'claude-calls.json');
const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, 'utf8')) : [];
const prompt = fs.readFileSync(0, 'utf8');
calls.push({ args, cwd: process.cwd(), prompt });
fs.writeFileSync(callsFile, JSON.stringify(calls));
const n = calls.length;
const out = (o) => console.log(JSON.stringify(o));
const modes = (process.env.MOCK_CLAUDE || '').split(',');
const mode = modes[Math.min(n - 1, modes.length - 1)];
const session_id = 'sess-1';

out({ type: 'system', subtype: 'init', session_id, tools: [] });
if (mode === 'auth') {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id });
  process.exit(1);
}
if (mode === 'limit') {
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' }, session_id });
  out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", session_id });
  process.exit(1);
}
if (mode === 'hang') {
  // Enkelprozess, um das Beenden des gesamten Prozessbaums zu prüfen.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(state, 'grandchild.pid'), String(child.pid));
  fs.writeFileSync(path.join(process.cwd(), 'teilweise.txt'), 'vor dem Abbruch geschrieben\n');
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'arbeite…' }] }, session_id });
  setInterval(() => {}, 1000);
} else {
  if (mode !== 'noop') {
    fs.writeFileSync(path.join(process.cwd(), `impl-${n}.txt`), `Inhalt ${n}\n`);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `impl-${n}.txt` } }] }, session_id });
  }
  const denials = [];
  if (mode === 'denied') {
    out({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'npm install wurde nicht freigegeben', session_id });
    denials.push({ tool_name: 'Bash', tool_input: { command: 'npm install' } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fertig ' + n }] }, session_id });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Zusammenfassung ' + n, session_id, usage: { input_tokens: 5, output_tokens: 7 }, permission_denials: denials });
}
