# Übertrag aus Plan 3 in Plan 4

Fundstellen aus dem Abschluss-Review von `plan-03-github-client`, die dort
bewusst nicht behoben wurden. Jede nennt, warum sie liegen bleiben durfte und
was sie kostet, wenn die Entscheidung falsch war.

## 1. Spec-Abweichung: `frozen` deckt fünf Zustände statt einem

`githubClient.head()` antwortet `null` auf fünf verschiedene Lagen — kein
Installations-Token, Repo 404, Commits 404, Commits 409, echte Löschung — und
`syncLog` bildet alle fünf auf `state: 'frozen'` ab.

Spec §10 trennt sie: eine suspendierte oder entfernte Installation bedeutet
**kein Abgleich bei weiterlaufender Auslieferung**, `frozen` ist dem
gelöschten Repo vorbehalten. Spec §4 überspringt `frozen`-Logs beim Abgleich —
also friert eine vorübergehende Störung einen Log ein, den die Reconcile-
Schleife danach nie wieder ansieht, und §10s "der nächste erfolgreiche
Abgleich taut den Log von selbst auf" kann nie eintreten.

Plan 4 muss eines von beiden tun: `frozen`-Logs nicht überspringen, oder
`head()` beibringen, "nicht installiert" von "weg" zu unterscheiden.

**Kostet, wenn falsch:** ein Log, das ein fünfminütiger Ausfall einfriert,
bleibt für immer eingefroren.

## 2. Der Token-Cache hat keinen Invalidierungspfad

`installations()` schreibt in seinen `Map`, löscht aber nie. Ein Token, das
GitHub vorzeitig ungültig macht — geänderte Rechte, rotierter Schlüssel,
suspendierte und wieder aktivierte Installation — wird bis zu ~58 Minuten lang
an jedes Repository dieser Installation ausgegeben.

Ein 401 wird nicht wiederholt, scheitert also laut, und es gehen keine Daten
verloren. Der Zuschnitt der Behebung — ein `invalidate()` auf `Installations`,
das `githubClient` bei 401 ruft — gehört in Plan 4.

## 3. Ungefähr die Hälfte des Anfragebudgets ist Authentifizierung

Gemessen an einem Sync über vier Dateien: **17 Anfragen, 8 davon nutzbar.**
`tokenFor` löst die Installations-ID bei jedem Aufruf neu auf, auch wenn das
Token längst im Cache liegt, und `head()` und `repoId()` holen
`GET /repos/o/r` je einmal für sich.

Spec §4 gleicht jeden Log mindestens stündlich ab. Die Behebung ändert die
`GitHub`-Schnittstelle — `head()` gibt zurück, was es ohnehin geholt hat —,
und Plan 4 fasst sie ohnehin an.

## 4. Kleinigkeiten

- `API` und der identische vierzeilige Auth-Header-Block stehen doppelt in
  `lib/appAuth.ts` und `lib/github.ts`.
- `tree()`s zwei Fehlermeldungen ("no installation token" gegen "tree lookup
  failed: HTTP 404") sind für einen Aufrufer unterscheidbar. Heute liest sie
  nur der Operator, aber Plan 5s `no_installation`-Meldung liest genau diese
  Naht.
- `bin/reindex.ts` verlangt `GITHUB_WEBHOOK_SECRET` und `BASE_URL`, obwohl auf
  diesem Pfad nichts sie liest.
- Der `import.meta.main`-Block in `bin/reindex.ts` — Argumentparsing, die
  `owner/repo/extra`-Zurückweisung, die Exit-Codes — hat keinen Test. Dafür
  fehlt dem Projekt ein Subprozess-Gerüst.
