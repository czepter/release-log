# Spike: GitHub App

Wegwerfcode. Schritt 0 der Bauabfolge in
`docs/superpowers/specs/2026-09-08-release-log-hub-design.md`.

Der Spike beantwortet Fragen, er baut nichts. Keine Zeile hiervon gehört in
den Dienst — was er liefert, ist eine Antwort, und die steht danach in der
Spec statt hier.

## Lauf

Voraussetzung: `scripts/setup-tunnel.sh` und `scripts/setup-github-app.sh`
sind gelaufen, der Tunnel läuft, `.env` steht.

```bash
cloudflared tunnel --config scripts/cloudflared-release-log-dev.yml run
node --env-file=.env spikes/github-app/spike.mjs
```

Der Spike öffnet einen Server auf `PORT` und druckt eine Autorisierungs-URL.
Die im Browser bestätigen; der Rest läuft von selbst.

## Fragen

1. Legt ein **Nutzer-Token** mit `administration: write` ein Repo auf dem
   persönlichen Konto an, und trägt der Refresh-Zyklus?
2. Gibt die Contents-API beim Commit die Blob-SHA zurück, die der
   Write-Through braucht?
3. Trägt der Baum-Abgleich innerhalb der Rate-Limits einer Installation?
4. Kommen Webhooks am Tunnel an, und verifiziert die Signaturprüfung sie?

Dazu eine, die beim Schreiben dazukam: **erreicht die Installation ein frisch
angelegtes Repo?** Bei `repository_selection=selected` vermutlich nicht — dann
muss `create_log` das neue Repo erst zur Installation hinzufügen, und das ist
ein Schritt, den die Spec noch nicht kennt.

## Aufräumen

Der Spike legt ein privates Wegwerf-Repo an und nennt am Ende den Befehl zum
Löschen. Er löscht es nicht selbst.
