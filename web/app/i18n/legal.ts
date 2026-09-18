// Was Impressum und Datenschutzerklärung gemeinsam haben: die Anschrift des
// Verantwortlichen und die Form, in der beide Seiten ihren Text ablegen.
// Beides steht hier, damit eine Adressänderung eine Datei trifft und nicht
// zwei -- eine Anschrift, die auf zwei Pflichtseiten auseinanderläuft, ist
// schlimmer als eine fehlende.

// Ein Absatz ist ein String, eine Aufzählung ein Array von Strings.
// Reicht für einen Rechtstext; eine Block-Union mit Typfeld wäre für
// "Text oder Liste" die zweite Abstraktion zu viel.
export type Block = string | string[];
// `contact` hängt die Anschrift des Verantwortlichen an den Abschnitt an.
// Sie steht in keiner der beiden Sprachlisten, weil eine Anschrift sich
// nicht übersetzt -- und weil sie sonst zweimal gepflegt werden müsste.
export type Section = { heading: string; blocks: Block[]; contact?: boolean };

export type LegalMeta = { title: string; description: string; intro: string; updated: string; back: string };

export const CONTROLLER = {
  name: 'Christian Zepter',
  street: 'Am Planetarium 37',
  city: '07743 Jena',
  country: 'Deutschland',
  email: 'info@release-log.dev',
  // Betrieb dieses Dienstes. Der Satz zum Auftragsverarbeitungsvertrag
  // steht im übersetzten Text, nicht hier: eine Anschrift ist sprachlos,
  // ein Satz nicht.
  hostingProvider: 'netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Deutschland',
  hostingLocation: 'Nürnberg, Deutschland',
  // Aufsichtsbehörde am Sitz des Verantwortlichen (Jena, Thüringen).
  authority: 'Thüringer Landesbeauftragter für den Datenschutz und die Informationsfreiheit (TLfDI), Häßlerstraße 8, 99096 Erfurt, https://www.tlfdi.de',
  updated: '2026-09-18',
};
