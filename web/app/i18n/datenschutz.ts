// Die Datenschutzerklärung. Sie steht bewusst nicht in de.ts/en.ts: dort
// liegen Oberflächentexte, die über `satisfies Messages` aneinander
// gebunden und von messages.test.ts auf Schlüsselgleichheit geprüft
// werden -- ein paar Dutzend Absätze Rechtstext würden diese Dateien
// unbrauchbar machen. Gleiche Locale-Keys, eigene Datei.
//
// Der Inhalt beschreibt, was dieser Dienst tatsächlich tut; jeder
// Abschnitt nennt die Codestelle, aus der er stammt. Wer den Code
// ändert, ändert hier mit -- sonst wird die Erklärung falsch, und eine
// falsche Datenschutzerklärung ist schlimmer als keine.

import type { Locale } from './messages.ts';
import type { LegalMeta, Section } from './legal.ts';

// Anschrift, Hoster und Aufsichtsbehörde stehen in legal.ts: das
// Impressum braucht dieselben Angaben.

const de: Section[] = [
  {
    heading: '1. Überblick',
    blocks: [
      'release-log verwandelt ein GitHub-Repository in ein Release-Log. Diese Erklärung beschreibt, welche personenbezogenen Daten dabei anfallen, wozu sie verarbeitet werden und wie lange sie liegen bleiben.',
      'Der Dienst kommt ohne Tracking aus: keine Analyse-Werkzeuge, keine Werbenetzwerke, keine Einbindung fremder Schriftarten oder CDNs, keine Weitergabe von Daten zu Werbezwecken. Es gibt deshalb auch keinen Cookie-Banner: Wer nur liest, bekommt gar kein Cookie, und die wenigen, die Anmeldung und Sprachwahl setzen, sind technisch notwendig (§ 25 Abs. 2 Nr. 2 TDDDG).',
      'Öffentliche Release-Log-Seiten sind ohne Anmeldung lesbar. Erst wer sich anmeldet, hinterlässt ein Konto.',
    ],
  },
  {
    heading: '2. Verantwortlicher',
    contact: true,
    blocks: [
      'Verantwortlich für die Datenverarbeitung auf dieser Website im Sinne des Art. 4 Nr. 7 DSGVO ist:',
      'Ein Datenschutzbeauftragter ist nicht bestellt; die gesetzlichen Voraussetzungen des Art. 37 DSGVO bzw. § 38 BDSG liegen nicht vor.',
      'Die vollständige Anbieterkennzeichnung nach § 5 DDG steht im Impressum unter /impressum.',
    ],
  },
  {
    heading: '3. Betrieb und Server-Logdateien',
    blocks: [
      'Der Dienst wird betrieben bei {provider}; der Server steht in {location}. Ein Auftragsverarbeitungsvertrag nach Art. 28 DSGVO liegt vor. Beim Aufruf einer Seite überträgt Ihr Browser technisch notwendige Daten (IP-Adresse, Zeitpunkt, angefragte Adresse, Statuscode, User-Agent), die beim Betrieb des Servers anfallen.',
      'Die Anwendung selbst legt keine dauerhaften Zugriffsprotokolle an. Die IP-Adresse wird ausschließlich flüchtig im Arbeitsspeicher verwendet, um die Anfragen an der Client-Registrierung und der Token-Ausgabe zu begrenzen (Missbrauchsschutz); ein Neustart des Dienstes löscht diese Zähler vollständig. Ob und wie lange der Hosting-Anbieter darüber hinaus protokolliert, richtet sich nach dessen Datenschutzhinweisen.',
      'Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO: das berechtigte Interesse an einem technisch fehlerfreien und gegen Missbrauch geschützten Betrieb.',
      'Die Verbindung ist durchgehend mit TLS verschlüsselt, erkennbar am „https://“ in der Adresszeile.',
    ],
  },
  {
    heading: '4. Cookies',
    blocks: [
      'Wer diese Seiten nur liest, bekommt kein einziges Cookie gesetzt — auch nicht beim Aufruf eines öffentlichen Release-Logs. Cookies entstehen ausschließlich durch eine Handlung, die Sie selbst auslösen: die Anmeldung und das Umschalten der Sprache.',
      'Diese Cookies sind technisch notwendig und nach § 25 Abs. 2 Nr. 2 TDDDG einwilligungsfrei, weil ohne sie die ausdrücklich gewünschte Funktion nicht möglich wäre. Rechtsgrundlage der damit verbundenen Verarbeitung ist Art. 6 Abs. 1 lit. b DSGVO (Anmeldung) bzw. Art. 6 Abs. 1 lit. f DSGVO (Sprachwahl, Schutz des Anmeldevorgangs).',
      [
        '`session` — hält Sie angemeldet. Enthält Ihre Konto-Kennung und einen Ablaufzeitpunkt, mit einem Serverschlüssel signiert. Laufzeit 30 Tage, HttpOnly, Secure, SameSite=Lax.',
        '`rl_lang` — merkt sich die gewählte Sprache (Deutsch oder Englisch). Laufzeit ein Jahr, SameSite=Lax. Ohne dieses Cookie entscheidet der Accept-Language-Header Ihres Browsers.',
        '`oauth_state` und `login_next` — sichern den Anmeldevorgang gegen untergeschobene Anfragen (CSRF) und merken sich das Ziel nach der Anmeldung. Laufzeit 10 Minuten, nur für den Pfad /auth/github, HttpOnly, Secure.',
      ],
      'Beim Abmelden wird das Sitzungs-Cookie sofort gelöscht. Sie können Cookies jederzeit in Ihrem Browser löschen oder blockieren; Anmeldung und Sprachwahl funktionieren dann nicht mehr.',
    ],
  },
  {
    heading: '5. Anmeldung über GitHub',
    blocks: [
      'Eine Anmeldung ist ausschließlich über ein GitHub-Konto möglich. Dabei werden Sie zu GitHub weitergeleitet und melden sich dort an; wir erhalten Ihr Passwort nicht.',
      'Nach erfolgreicher Anmeldung speichern wir dauerhaft:',
      [
        'Ihre GitHub-Nutzerkennung (numerische ID),',
        'Ihren GitHub-Anmeldenamen (Login),',
        'die Adresse Ihres Profilbildes bei GitHub,',
        'den Zeitpunkt der letzten Anmeldung.',
      ],
      'Diese Daten sind nötig, um Ihr Konto wiederzuerkennen, Ihre Logs zuzuordnen und zu prüfen, ob Sie Schreibrechte am jeweiligen Repository haben. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Erfüllung des Nutzungsverhältnisses).',
      'Anbieter ist GitHub, Inc., 88 Colin P. Kelly Jr. Street, San Francisco, CA 94107, USA, ein Unternehmen von Microsoft. Mit dem Aufruf des Anmeldevorgangs werden Daten in die USA übermittelt. GitHub ist unter dem EU-US Data Privacy Framework zertifiziert; ergänzend gelten die Standardvertragsklauseln der EU-Kommission. Datenschutzerklärung von GitHub: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement',
      'Zusätzlich speichern wir Ihr persönliches GitHub-Zugriffstoken, verschlüsselt mit AES-256-GCM. Es wird für genau einen Zweck benutzt: ein neues Repository in Ihrem Namen anzulegen, wenn Sie das über „Neues Log" verlangen. Jeder andere Zugriff auf Repositorys läuft über die GitHub-App-Installation, nicht über Ihr Token.',
    ],
  },
  {
    heading: '6. Verbundene Clients (MCP / OAuth)',
    blocks: [
      'Sie können Programme (etwa einen MCP-Client) mit Ihrem Konto verbinden. Dabei speichern wir den vom Client gemeldeten Namen, seine Weiterleitungsadressen, den Zeitpunkt der Registrierung sowie die Gültigkeit und den Umfang der ausgegebenen Zugriffsrechte.',
      'Die ausgegebenen Token selbst werden nicht gespeichert, sondern nur ihre Hashwerte: Was in der Datenbank steht, reicht zum Prüfen eines vorgelegten Tokens, nicht zum Benutzen. Autorisierungscodes verfallen nach 60 Sekunden, Upload-Erlaubnisse nach 10 Minuten.',
      'Unter „Konto & Clients" können Sie jede Verbindung trennen; damit werden alle zugehörigen Token sofort widerrufen. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO.',
    ],
  },
  {
    heading: '7. Inhalte aus Ihren Repositorys',
    blocks: [
      'Der Dienst liest die Dateien `release-log.json`, `releases/*.json` und den Ordner `media/` aus den von Ihnen verbundenen Repositorys und legt sie in einem Index ab, um sie schnell ausliefern zu können. Gespeichert werden dabei Repository-Eigentümer und -Name, die GitHub-interne Repository-Kennung, die Inhalte der Releases, hochgeladene Bilder sowie Fehlermeldungen aus der Verarbeitung.',
      'Ob dieser Inhalt personenbezogene Daten enthält — etwa Namen von Mitwirkenden — entscheiden Sie als Autor des Repositorys. Ein Log mit der Sichtbarkeit „öffentlich" ist über eine öffentliche Adresse und über die öffentliche JSON-Schnittstelle für jeden abrufbar und kann von Suchmaschinen erfasst werden. Veröffentlichen Sie dort keine Daten, die nicht öffentlich sein sollen.',
      'Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO; die Veröffentlichung erfolgt auf Ihre Veranlassung.',
    ],
  },
  {
    heading: '8. Speicherdauer',
    blocks: [
      [
        'Kontodaten: bis zur Löschung des Kontos (siehe Abschnitt 10).',
        'Verschlüsseltes GitHub-Token: bis zur Löschung des Kontos oder bis Sie den Zugriff bei GitHub entziehen.',
        'Indexierte Log-Inhalte: bis das Log gelöscht wird. Wird ein Repository entfernt, wird das Log eingefroren — der letzte Stand bleibt gespeichert und wird weiter ausgeliefert, bis Sie die Löschung verlangen.',
        'Token-Hashes verbundener Clients: bis zum Ablauf oder Widerruf.',
        'Rate-Limit-Zähler mit IP-Adresse: nur im Arbeitsspeicher, längstens bis zum nächsten Neustart des Dienstes.',
      ],
    ],
  },
  {
    heading: '9. Empfänger',
    blocks: [
      'Eine Weitergabe an Dritte findet nicht statt, ausgenommen:',
      [
        'GitHub, Inc. — für Anmeldung, Lesen und Schreiben in Ihren Repositorys (siehe Abschnitt 5),',
        'der Hosting-Anbieter als Auftragsverarbeiter nach Art. 28 DSGVO (siehe Abschnitt 3),',
        'jedermann — soweit Sie ein Log ausdrücklich öffentlich stellen (siehe Abschnitt 7).',
      ],
      'Eine Verarbeitung zu Werbezwecken, ein Verkauf von Daten oder eine automatisierte Entscheidungsfindung einschließlich Profiling nach Art. 22 DSGVO findet nicht statt.',
    ],
  },
  {
    heading: '10. Ihre Rechte',
    blocks: [
      'Sie haben jederzeit das Recht auf:',
      [
        'Auskunft über die zu Ihrer Person gespeicherten Daten (Art. 15 DSGVO),',
        'Berichtigung unrichtiger Daten (Art. 16 DSGVO),',
        'Löschung (Art. 17 DSGVO),',
        'Einschränkung der Verarbeitung (Art. 18 DSGVO),',
        'Datenübertragbarkeit in einem gängigen Format (Art. 20 DSGVO),',
        'Widerspruch gegen Verarbeitungen, die auf Art. 6 Abs. 1 lit. f DSGVO beruhen (Art. 21 DSGVO),',
        'Widerruf einer erteilten Einwilligung mit Wirkung für die Zukunft (Art. 7 Abs. 3 DSGVO).',
      ],
      'Zur Ausübung genügt eine formlose Nachricht an die in Abschnitt 2 genannte Adresse. Eine Löschung Ihres Kontos ist derzeit nicht als Schaltfläche in der Oberfläche umgesetzt; wir löschen Konto, gespeichertes Token und indexierte Logs auf Anfrage. Unabhängig davon können Sie die Verbindung jederzeit selbst beenden, indem Sie unter „Konto & Clients" die verbundenen Clients trennen und die GitHub-App in Ihren GitHub-Einstellungen deinstallieren.',
      'Wenn Sie der Ansicht sind, dass die Verarbeitung Ihrer Daten gegen die DSGVO verstößt, steht Ihnen unbeschadet anderer Rechtsbehelfe ein Beschwerderecht bei einer Aufsichtsbehörde zu (Art. 77 DSGVO), insbesondere in dem Mitgliedstaat Ihres Aufenthaltsorts, Ihres Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes. Zuständig für den Verantwortlichen ist: {authority}.',
    ],
  },
  {
    heading: '11. Änderungen dieser Erklärung',
    blocks: [
      'Diese Erklärung wird angepasst, sobald sich die beschriebene Verarbeitung ändert. Es gilt die jeweils hier veröffentlichte Fassung.',
    ],
  },
];

const en: Section[] = [
  {
    heading: '1. Overview',
    blocks: [
      'release-log turns a GitHub repository into a release log. This policy describes which personal data that involves, why it is processed and how long it is kept. German data protection law applies; the German version of this page prevails in case of doubt.',
      'The service runs without tracking: no analytics, no ad networks, no third-party fonts or CDNs, no sharing of data for advertising. There is therefore no cookie banner: if you only read, no cookie is set at all, and the few that signing in and switching language do set are strictly necessary (§ 25(2)(2) TDDDG).',
      'Public release log pages can be read without signing in. Only signing in creates an account.',
    ],
  },
  {
    heading: '2. Controller',
    contact: true,
    blocks: [
      'The controller for data processing on this website within the meaning of Art. 4(7) GDPR is:',
      'No data protection officer has been appointed; the conditions of Art. 37 GDPR and § 38 BDSG are not met.',
      'The full provider identification under § 5 DDG is on the imprint page at /impressum.',
    ],
  },
  {
    heading: '3. Operation and server logs',
    blocks: [
      'The service is operated at {provider}; the server is located in {location}. A processing agreement under Art. 28 GDPR is in place. When you open a page, your browser transmits technically necessary data (IP address, time, requested address, status code, user agent) that arises from running the server.',
      'The application itself keeps no persistent access logs. Your IP address is used only transiently in memory, to rate-limit requests to client registration and token issuance (abuse protection); restarting the service clears those counters entirely. Whether and for how long the hosting provider logs beyond that is governed by its own privacy notice.',
      'The legal basis is Art. 6(1)(f) GDPR: the legitimate interest in operating the service reliably and protecting it against abuse.',
      'The connection is TLS-encrypted throughout, shown by the "https://" in the address bar.',
    ],
  },
  {
    heading: '4. Cookies',
    blocks: [
      'If you only read these pages, no cookie is set at all — not even when you open a public release log. Cookies appear solely through an action you take yourself: signing in, and switching the language.',
      'These cookies are strictly necessary and exempt from consent under § 25(2)(2) TDDDG, because the function you explicitly requested would not work without them. The legal basis for the associated processing is Art. 6(1)(b) GDPR (sign-in) and Art. 6(1)(f) GDPR (language choice, protecting the sign-in flow).',
      [
        '`session` — keeps you signed in. Holds your account id and an expiry, signed with a server key. Lifetime 30 days, HttpOnly, Secure, SameSite=Lax.',
        '`rl_lang` — remembers the chosen language (German or English). Lifetime one year, SameSite=Lax. Without it, your browser\'s Accept-Language header decides.',
        '`oauth_state` and `login_next` — protect the sign-in flow against forged requests (CSRF) and remember where to go afterwards. Lifetime 10 minutes, scoped to /auth/github, HttpOnly, Secure.',
      ],
      'Signing out deletes the session cookie immediately. You can delete or block cookies in your browser at any time; sign-in and language choice will then no longer work.',
    ],
  },
  {
    heading: '5. Signing in with GitHub',
    blocks: [
      'Signing in is possible only with a GitHub account. You are redirected to GitHub and authenticate there; we never receive your password.',
      'After a successful sign-in we store permanently:',
      [
        'your GitHub user id (numeric),',
        'your GitHub login name,',
        'the address of your GitHub avatar image,',
        'the time of your last sign-in.',
      ],
      'This data is needed to recognise your account, attribute your logs to you and check whether you hold write access to the repository in question. The legal basis is Art. 6(1)(b) GDPR (performance of the user relationship).',
      'The provider is GitHub, Inc., 88 Colin P. Kelly Jr. Street, San Francisco, CA 94107, USA, a Microsoft company. Starting the sign-in flow transfers data to the USA. GitHub is certified under the EU-US Data Privacy Framework; the EU Commission\'s standard contractual clauses apply in addition. GitHub\'s privacy statement: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement',
      'We also store your personal GitHub access token, encrypted with AES-256-GCM. It is used for exactly one purpose: creating a new repository on your behalf when you ask for one via "New log". Every other repository access goes through the GitHub App installation, not through your token.',
    ],
  },
  {
    heading: '6. Connected clients (MCP / OAuth)',
    blocks: [
      'You can connect programs (such as an MCP client) to your account. We then store the name the client reports, its redirect addresses, the time of registration, and the validity and scope of the access rights issued.',
      'The issued tokens themselves are not stored, only their hashes: what is in the database is enough to verify a token presented to us, not to use one. Authorisation codes expire after 60 seconds, upload permissions after 10 minutes.',
      'Under "Account & clients" you can disconnect any client, which revokes all its tokens immediately. The legal basis is Art. 6(1)(b) GDPR.',
    ],
  },
  {
    heading: '7. Content from your repositories',
    blocks: [
      'The service reads `release-log.json`, `releases/*.json` and the `media/` folder from the repositories you connect and keeps them in an index so they can be served quickly. It stores the repository owner and name, GitHub\'s internal repository id, the release contents, uploaded images, and any errors encountered while processing them.',
      'Whether that content contains personal data — contributor names, for instance — is your decision as the author of the repository. A log whose visibility is "public" is reachable by anyone at a public address and through the public JSON API, and may be indexed by search engines. Do not publish anything there that should not be public.',
      'The legal basis is Art. 6(1)(b) GDPR; publication happens at your instruction.',
    ],
  },
  {
    heading: '8. Retention',
    blocks: [
      [
        'Account data: until the account is deleted (see section 10).',
        'Encrypted GitHub token: until the account is deleted or you revoke access at GitHub.',
        'Indexed log content: until the log is deleted. If a repository is removed, the log is frozen — the last state stays stored and served until you ask for its deletion.',
        'Token hashes of connected clients: until they expire or are revoked.',
        'Rate-limit counters holding an IP address: in memory only, at most until the service restarts.',
      ],
    ],
  },
  {
    heading: '9. Recipients',
    blocks: [
      'Data is not passed to third parties, except:',
      [
        'GitHub, Inc. — for sign-in and for reading and writing your repositories (see section 5),',
        'the hosting provider, as a processor under Art. 28 GDPR (see section 3),',
        'anyone — to the extent you deliberately make a log public (see section 7).',
      ],
      'There is no processing for advertising, no sale of data and no automated decision-making including profiling within the meaning of Art. 22 GDPR.',
    ],
  },
  {
    heading: '10. Your rights',
    blocks: [
      'You have the right at any time to:',
      [
        'access the data held about you (Art. 15 GDPR),',
        'rectification of inaccurate data (Art. 16 GDPR),',
        'erasure (Art. 17 GDPR),',
        'restriction of processing (Art. 18 GDPR),',
        'data portability in a common format (Art. 20 GDPR),',
        'object to processing based on Art. 6(1)(f) GDPR (Art. 21 GDPR),',
        'withdraw consent with effect for the future (Art. 7(3) GDPR).',
      ],
      'An informal message to the address in section 2 is enough. Deleting your account is not yet available as a button in the interface; we delete the account, the stored token and the indexed logs on request. Independently of that, you can end the connection yourself at any time: disconnect the clients under "Account & clients" and uninstall the GitHub App in your GitHub settings.',
      'If you believe the processing of your data infringes the GDPR, you have the right to lodge a complaint with a supervisory authority (Art. 77 GDPR), in particular in the member state of your residence, place of work or the place of the alleged infringement, without prejudice to other remedies. The authority responsible for the controller is: {authority}.',
    ],
  },
  {
    heading: '11. Changes to this policy',
    blocks: [
      'This policy is updated whenever the processing it describes changes. The version published here at the time applies.',
    ],
  },
];

export const PRIVACY: Record<Locale, Section[]> = { de, en };

export const PRIVACY_META: Record<Locale, LegalMeta> = {
  de: {
    title: 'Datenschutzerklärung · release-log',
    description: 'Welche Daten release-log verarbeitet, wozu und wie lange.',
    intro: 'Datenschutzerklärung',
    updated: 'Stand: {date}',
    back: 'Zur Startseite',
  },
  en: {
    title: 'Privacy Policy · release-log',
    description: 'What data release-log processes, why, and for how long.',
    intro: 'Privacy Policy',
    updated: 'Last updated: {date}',
    back: 'Back to the start page',
  },
};
