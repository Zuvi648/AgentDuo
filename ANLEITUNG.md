# Agent Duo – Kurzanleitung

Agent Duo koordiniert zwei lokale CLIs: **Codex** plant und prüft (nur Lesezugriff), **Claude Code** implementiert.

Ablauf: Aufgabe → Codex-Plan → (Plan bestätigen) → Claude-Implementierung → Tests → Codex-Review → ggf. Korrekturrunde → Ergebnis.

## Starten

- Fertige App: `release/mac-arm64/Agent Duo.app` oder `release/Agent Duo-0.1.0-arm64.dmg` (Apple Silicon).
  Die App ist nur ad-hoc signiert und nicht notarisiert. Auf anderen Macs beim ersten Start: Rechtsklick → „Öffnen“.
- Aus dem Quellcode (Node.js 22 liegt projektlokal unter `.tools/node`):

  ```bash
  export PATH="$PWD/.tools/node/bin:$PATH"
  npm install
  npm start
  ```

## Einrichtung

1. **Einrichtung** öffnen. Die App zeigt Pfad, Version und Anmeldestatus von Codex CLI, Claude Code und Git.
   Gesucht wird im PATH der Login-Shell, an üblichen Installationsorten und in den Desktop-Apps (ChatGPT, Claude).
2. Fehlt eine CLI: „Über offiziellen Weg installieren“ (startet erst nach dem Klick, Ergebnis steht im Protokoll).
3. „Anmelden…“ öffnet ein Terminal mit `codex login` bzw. `claude auth login`. Danach „Erneut prüfen“.
4. „Verbindung testen“ sendet je eine sehr kleine echte Anfrage.

Agent Duo liest keine Token-Dateien und speichert keine Passwörter. Standardmäßig wird nur die Abo-Anmeldung akzeptiert;
API-Variablen wie `ANTHROPIC_API_KEY` oder `OPENAI_API_KEY` werden nicht an die CLIs weitergegeben und als Hinweis angezeigt.

## Nutzung

1. Links bei **Profil** auf **+** klicken und den Projektordner wählen (Git-Repository mit mindestens einem Commit).
2. Aufgabe eingeben, bei Bedarf Modell und Denkaufwand für beide Agenten wählen, **Start**.
3. Plan, Prüfbefehle und Claude-Auftrag prüfen, bei Bedarf bearbeiten, **bestätigen**.
4. Reiter: Karte (Ablauf als Baum, laufende Schritte pulsieren), Live-Ausgaben, Git-Diff, Tests (echte Exit-Codes), Review, Verbrauch je Schritt.
5. **Pause nach Schritt**, **Fortsetzen**, **Sofort abbrechen** (beendet auch Kindprozesse, Änderungen bleiben erhalten).

Die Änderungen liegen danach in einer getrennten Kopie deines Projekts (Worktree, Branch `agent-duo/<id>`).
Es wird nie automatisch committet, gepusht oder gemergt.

## Veröffentlichen und Deploy-Pipeline

Im Reiter **Veröffentlichen** einer Aufgabe gibt es drei Schritte, jeder mit einem Klick:

1. **Änderungen sichern** – speichert den Stand als Commit auf deinem Rechner.
2. **In dein Projekt übernehmen** – holt die Änderungen in deinen Projekt-Branch (mit Rückfrage; bei Konflikten passiert nichts).
3. **Auf GitHub hochladen** – Push nach `origin` (mit Rückfrage). Eine vorhandene Pipeline startet danach von selbst.

Statt Schritt 2 und 3 geht auch „Lieber als Pull Request hochladen“.

Unter **Projekt & Notizen → GitHub und Deploy-Pipeline** verbindest du das Projekt mit einem GitHub-Repository
(Adresse einfügen) und lässt die Agenten eine Pipeline bauen: „Webseite veröffentlichen“ (GitHub Pages),
„Tests automatisch ausführen“ oder eine eigene. Ein Klick füllt eine neue Aufgabe vor.

Voraussetzung fürs Hochladen: Git ist auf dem Rechner bei GitHub angemeldet (am einfachsten GitHub CLI installieren und `gh auth login`).
Agent Duo fragt nie nach deinem GitHub-Passwort.

Der Ablauf hält an und fragt nach, wenn Codex eine Entscheidung braucht, Claude eine Freigabe verweigert wurde,
eine Korrekturrunde nichts geändert hat oder die maximale Rundenzahl (Standard 3) erreicht ist.
Bei Login-Fehlern und Nutzungslimits stoppt er ohne Wiederholung und ohne Anbieterwechsel.

## Profile, Notizen und Journal

Ein Profil gehört zu einem Projektordner und merkt sich Standardmodelle, deine **Notizen** („wo bin ich stehen geblieben?“)
und **dauerhafte Vorgaben** für beide Agenten. Nach jedem Review schreibt die App automatisch einen kurzen Stand ins **Journal**.
Notizen, Vorgaben und die letzten fünf Journal-Einträge gehen bei jeder Aufgabe an beide Agenten (höchstens 3.000 Zeichen).
Unter „Projekt & Notizen“ zeigt die **Projektkarte** alle Aufgaben des Profils mit Ziel, Runden und geänderten Dateien.

## Modelle und Kontingent sparen

- **Modellauswahl:** je Profil und je Aufgabe. Codex-Modelle und Aufwandsstufen stammen aus der Modell-Liste der Codex CLI,
  bei Claude die Aliasse `fable`, `opus`, `sonnet`, `haiku` und die Stufen von `--effort`. Leer = Standard der CLI.
- **Sparmodus** (Standard: an): Beide Agenten bekommen die Arbeitsregeln (nur relevante Dateien lesen, kleine Patches,
  keine unnötigen Tests/Builds, kurze Zusammenfassung). Claude Code startet mit `--strict-mcp-config --disable-slash-commands`,
  also ohne MCP-Server und Skills. Codex führt beim Review die Prüfungen nicht erneut aus.
- **Nutzung:** Claude Code meldet die Auslastung des 5-Stunden- und 7-Tage-Fensters; die App zeigt sie oben und unter „Nutzung“.
  Codex liefert in diesem Modus nur Token je Aufruf. Kosten werden nicht angezeigt.
- Meldet Claude Code kostenpflichtige Zusatznutzung, stoppt der Lauf.

Gemessen am 12.10.2026 mit derselben kleinen Testaufgabe, je ein Lauf (nur ein Anhaltspunkt):

| | ohne Sparmodus | mit Sparmodus |
| --- | --- | --- |
| Claude Code, Eingabe-Tokens | 94.314 | 63.714 |
| Codex, Eingabe-Tokens | 66.871 | 49.481 |

## Sicherheit

- Codex läuft mit `-s read-only` (in fortgesetzten Sitzungen `-c sandbox_mode="read-only"`).
- Claude Code läuft mit `--permission-mode acceptEdits` und einer Allowlist (Einstellungen). Keine Bypass-Flags.
- Prüfbefehle werden ohne Shell ausgeführt; Pipes, `&&` usw. werden abgelehnt.
- Uncommittete Änderungen im Projektordner bleiben unberührt. Im Worktree-Modus sieht der Agent sie nicht;
  ohne Worktree werden sie vorher unter `refs/agent-duo/backup/<id>` gesichert.
- Daten liegen lokal unter `~/Library/Application Support/Agent Duo/` (`data/`, `worktrees/`); Logs werden von Geheimnissen bereinigt.

## Entwicklung und Tests

```bash
npm run typecheck
npm test                 # 24 Tests mit Mock-CLIs (Parser, Ablauf, Abbruch, Neustart, Git-Schutz)
node scripts/smoke.mjs   # startet die echte App, prüft Oberfläche, Sandbox, IPC und einen Demo-Lauf
npm run e2e              # echter Lauf mit beiden CLIs in einem Wegwerf-Repository (verbraucht Kontingent)
npm run dist:mac         # .app und .dmg nach release/
npm run dist:win         # .exe-Installer (NSIS), auf Windows ausführen
```

Releases: `.github/workflows/release.yml` baut bei einem Tag `v*` die macOS-App (Apple Silicon, `.dmg`) und den Windows-Installer (`.exe`) und hängt beide an ein GitHub-Release.

## Stand vom 12.10.2026

| Bereich | Stand |
| --- | --- |
| macOS `.app` und `.dmg` (arm64) | erzeugt; `.app` per Rauchtest gestartet und geprüft, `.dmg` nicht geöffnet |
| Unit-/Integrationstests | 24 von 24 bestanden |
| Veröffentlichen (Commit, Merge, Push) | mit lokalem Test-Repository als „GitHub“ getestet; echter Push zu GitHub aus der App nicht getestet |
| Echter End-to-End-Lauf (Codex 0.162.0-alpha.17.2, Claude Code 2.1.295, Abo-Login) | bestanden, auch im Sparmodus: Plan → Implementierung → `node test.js` Exit 0 → Review „accepted“ → Journal-Eintrag |
| Profil, Karte, Modellauswahl, Nutzungsansicht | per Rauchtest in der echten App geprüft; Modellwechsel selbst nur mit Mocks getestet (echter Lauf mit Standardmodellen) |
| Lesezugriff von Codex | real geprüft: Schreibversuch scheitert frisch und in fortgesetzter Sitzung |
| Windows-Build | nur vorbereitet, nicht gebaut und nicht getestet |
| Signierung / Notarisierung | keine (kein Zertifikat) |

## Bekannte Einschränkungen

- Im echten Lauf nicht ausgelöst und nur mit Mocks getestet: Korrekturrunde, Nutzungslimit, Login-Fehler, Abbruch, Neustart.
- Die Schaltflächen „Installieren“ und „Anmelden…“ wurden nicht per Klick getestet (beide CLIs waren vorhanden; Claude wurde im Terminal angemeldet).
- Der Worktree enthält keine unversionierten Dateien wie `node_modules`. Prüfbefehle, die Abhängigkeiten brauchen, schlagen dort fehl,
  bis sie installiert sind (z. B. `npm ci` als erste Prüfung eintragen oder den Worktree-Modus abschalten).
- Verweigert die CLI Claude eine Aktion, hält der Ablauf standardmäßig an – auch wenn Claude sich selbst beholfen hat. Abschaltbar in den Einstellungen.
- Windows: `.cmd`-Starter (npm-Installationen) werden nicht ausgeführt; es wird eine `.exe` benötigt. Codex-Installation dort nur per Link zur offiziellen Anleitung.
- Die mit den Desktop-Apps gebündelten CLIs wechseln bei App-Updates den Pfad; die automatische Suche findet die jeweils neueste Version.
- Kosten werden nicht angezeigt, nur die von den CLIs gemeldeten Token und die Claude-Auslastung.
- Der Sparmodus schaltet für Claude Code MCP-Server und Skills ab. Wer sie im Projekt braucht, schaltet ihn in den Einstellungen aus.
- Die Codex-Modell-Liste kommt aus dem Cache der CLI (`~/.codex/models_cache.json`); fehlt er, bleibt nur „Standardmodell“.
