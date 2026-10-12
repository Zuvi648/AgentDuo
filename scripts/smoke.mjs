// Rauchtest der echten Electron-App über das Chrome-DevTools-Protokoll:
// startet die App mit eigenem Datenordner, prüft die Oberfläche, lässt eine Demo-Aufgabe laufen.
// Aufruf: node scripts/smoke.mjs [pfad-zur-app-binärdatei] [screenshot-ordner]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bin = process.argv[2] || require('electron');
const shots = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duo-shots-'));
fs.mkdirSync(shots, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duo-smoke-'));
const port = 9300 + Math.floor(Math.random() * 500);
const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${data}`];
if (!process.argv[2]) args.unshift('.');
const app = spawn(bin, args, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (name, ok, extra = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` – ${extra}` : ''}`);
};

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('App-Fenster nicht erreichbar');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d.result);
  };
  const cdp = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  const evalJs = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'Auswertung fehlgeschlagen');
    return r.result.value;
  };
  const shot = async (name) => fs.writeFileSync(path.join(shots, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const waitFor = async (expr, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await evalJs(expr)) return true;
    return false;
  };
  const clickText = (t) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(t)})); if (!b) return false; b.click(); return true; })()`);

  check('Oberfläche geladen', await waitFor(`document.body.innerText.includes('Neue Aufgabe')`));
  check('Sandbox: kein Node im Renderer', await evalJs(`typeof require === 'undefined' && typeof process === 'undefined'`));
  check('IPC eng begrenzt', await evalJs(`window.api.invoke('nicht:erlaubt').then(() => false, () => true)`));
  check('Umgebungsprüfung liefert CLIs', await waitFor(`!document.body.innerText.includes('prüfe…')`, 30000), await evalJs(`[...document.querySelectorAll('.pill')].map(p => p.innerText).join(' | ')`));
  await shot('1-start.png');

  await clickText('Einrichtung');
  check('Einrichtung zeigt Versionen', await waitFor(`document.body.innerText.includes('Echter Test')`));
  await shot('2-einrichtung.png');
  await clickText('Einstellungen');
  check('Einstellungen sichtbar', await waitFor(`document.body.innerText.includes('Maximale Korrekturrunden')`));
  await shot('3-einstellungen.png');

  // Demo-Aufgabe vollständig durchlaufen lassen (keine CLI-Aufrufe)
  await evalJs(`window.api.invoke('task:create', 'Rauchtest im Demo-Modus', '', true).then(() => true)`);
  check('Demo: Plan wartet auf Bestätigung', await waitFor(`document.body.innerText.includes('wartet auf dich')`));
  await evalJs(`(() => { document.querySelector('.hist .item').click(); return true; })()`);
  await waitFor(`!!document.querySelector('.steps')`);
  await shot('4-plan.png');
  check('Plan bestätigen', await clickText('Plan bestätigen'));
  check('Demo: Ablauf endet akzeptiert', await waitFor(`document.querySelector('.step:last-child')?.classList.contains('done')`, 30000));
  check('Demo deutlich gekennzeichnet', await evalJs(`document.body.innerText.includes('DEMO')`));
  await sleep(300);
  await shot('5-ergebnis.png');
  check('Karte zeichnet den Ablauf', (await evalJs(`(() => { [...document.querySelectorAll('.tabs button')].find(b => b.textContent === 'Karte').click(); return true; })()`)) && (await waitFor(`document.querySelectorAll('.map-node').length >= 6`)), await evalJs(`document.querySelectorAll('.map-node').length + ' Knoten'`));
  await shot('6-karte.png');
  check('Reiter Veröffentlichen vorhanden', (await evalJs(`(() => { [...document.querySelectorAll('.tabs button')].find(b => b.textContent === 'Veröffentlichen').click(); return true; })()`)) && (await waitFor(`document.body.innerText.includes('nichts zu veröffentlichen')`)));

  // Profil mit Notizen anlegen, Modellkatalog und Nutzungsansicht prüfen
  const pid = await evalJs(`window.api.invoke('profile:save', { name: 'Rauchtest-Projekt', projectDir: ${JSON.stringify(data)}, notes: 'Stehen geblieben bei Schritt 3.', instructions: 'Kurz und sauber.' }).then(p => p.id)`);
  check('Profil gespeichert', typeof pid === 'string' && pid.length > 0);
  check('Modellkatalog', await evalJs(`window.api.invoke('models:list').then(c => c.claude.length >= 3)`), await evalJs(`window.api.invoke('models:list').then(c => c.codex.length + ' Codex-Modelle, ' + c.claude.length + ' Claude-Aliasse')`));
  await cdp('Page.reload');
  await sleep(800);
  check('Profil nach Neuladen sichtbar', await waitFor(`document.body.innerText.includes('Rauchtest-Projekt')`));
  await clickText('Projekt & Notizen');
  check('Profilansicht zeigt Notizen und Projektkarte', await waitFor(`document.body.innerText.includes('wo bin ich stehen geblieben') && [...document.querySelectorAll('textarea')].some(t => t.value.includes('Schritt 3')) && !!document.querySelector('.map')`));
  await shot('7-profil.png');
  check('Pipeline-Karte mit Vorlagen', await waitFor(`document.querySelectorAll('button.template').length === 3 || document.body.innerText.includes('noch kein Git-Repository')`));
  await clickText('Nutzung');
  check('Nutzungsansicht', await waitFor(`document.body.innerText.includes('Sparmodus') && document.body.innerText.includes('Kontingent')`));
  await shot('8-nutzung.png');
  await clickText('+ Neue Aufgabe');
  check('Neue Aufgabe zeigt Modellauswahl und Stand', await waitFor(`document.querySelectorAll('.models select').length === 4 && document.body.innerText.includes('Wo du stehen geblieben bist')`));
  await shot('9-neue-aufgabe.png');
  check('Aufgabe persistiert', fs.readdirSync(path.join(data, 'data', 'tasks')).length === 1);
  ws.close();
} catch (e) {
  check('Rauchtest', false, e.message);
} finally {
  app.kill();
  await sleep(500);
  fs.rmSync(data, { recursive: true, force: true });
}
console.log(`Screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
