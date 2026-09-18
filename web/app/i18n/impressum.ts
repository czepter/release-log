// Die Anbieterkennzeichnung nach § 5 DDG. Die Anschrift kommt aus
// legal.ts, damit sie sich nicht von der Datenschutzerklärung
// unterscheiden kann.

import type { Locale } from './messages.ts';
import type { LegalMeta, Section } from './legal.ts';

const de: Section[] = [
  {
    heading: 'Angaben gemäß § 5 DDG',
    contact: true,
    blocks: [
      'Diensteanbieter dieser Website ist:',
    ],
  },
  {
    heading: 'Verbraucherstreitbeilegung',
    blocks: [
      'Wir sind nicht bereit und nicht verpflichtet, an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle im Sinne des § 36 VSBG teilzunehmen.',
      'Die Online-Streitbeilegungsplattform der Europäischen Kommission wurde zum 20. Juli 2025 eingestellt; ein Verweis darauf entfällt daher.',
    ],
  },
  {
    heading: 'Haftung für Inhalte',
    blocks: [
      'Als Diensteanbieter sind wir nach § 7 Abs. 1 DDG für eigene Inhalte auf diesen Seiten verantwortlich. Nach den §§ 8 bis 10 DDG sind wir als Diensteanbieter jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.',
      'Die von Nutzerinnen und Nutzern veröffentlichten Release-Logs sind fremde Inhalte im Sinne dieser Vorschriften: Sie stammen aus deren GitHub-Repositorys und werden von diesem Dienst nur indexiert und ausgeliefert, nicht redaktionell geprüft. Verantwortlich für einen Release-Log-Inhalt ist, wer ihn veröffentlicht hat.',
      'Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben davon unberührt. Eine diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich. Bei Bekanntwerden entsprechender Rechtsverletzungen entfernen wir diese Inhalte umgehend. Hinweise bitte an die oben genannte E-Mail-Adresse.',
    ],
  },
  {
    heading: 'Haftung für Links',
    blocks: [
      'Dieses Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Deshalb können wir für diese fremden Inhalte auch keine Gewähr übernehmen. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber der Seiten verantwortlich. Die verlinkten Seiten wurden zum Zeitpunkt der Verlinkung auf mögliche Rechtsverstöße überprüft; rechtswidrige Inhalte waren nicht erkennbar.',
      'Eine permanente inhaltliche Kontrolle der verlinkten Seiten ist ohne konkrete Anhaltspunkte einer Rechtsverletzung nicht zumutbar. Bei Bekanntwerden von Rechtsverletzungen entfernen wir derartige Links umgehend.',
    ],
  },
  {
    heading: 'Urheberrecht',
    blocks: [
      'Die durch den Betreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen dem deutschen Urheberrecht. Beiträge Dritter sind als solche gekennzeichnet.',
      'Die Rechte an den veröffentlichten Release-Logs verbleiben bei deren Urhebern; für sie gilt, was das jeweilige Repository an Lizenz nennt.',
    ],
  },
  {
    heading: 'Datenschutz',
    blocks: [
      'Wie dieser Dienst mit personenbezogenen Daten umgeht, steht in der Datenschutzerklärung unter /datenschutz.',
    ],
  },
];

const en: Section[] = [
  {
    heading: 'Information pursuant to § 5 DDG',
    contact: true,
    blocks: [
      'The provider of this website is:',
      'This page is the legally required German Anbieterkennzeichnung; the German version prevails in case of doubt.',
    ],
  },
  {
    heading: 'Consumer dispute resolution',
    blocks: [
      'We are neither willing nor obliged to take part in dispute resolution proceedings before a consumer arbitration board within the meaning of § 36 VSBG.',
      'The European Commission\'s online dispute resolution platform was shut down on 20 July 2025, so no reference to it is given.',
    ],
  },
  {
    heading: 'Liability for content',
    blocks: [
      'As a service provider we are responsible for our own content on these pages under § 7(1) DDG. Under §§ 8 to 10 DDG, however, we are not obliged to monitor transmitted or stored third-party information, or to investigate circumstances that indicate unlawful activity.',
      'The release logs published by users are third-party content in this sense: they come from the users\' own GitHub repositories and are only indexed and served by this service, not editorially reviewed. Whoever published a release log is responsible for its content.',
      'Obligations to remove or block the use of information under general law remain unaffected. Liability in this respect is only possible from the point in time at which a specific infringement becomes known. We remove such content immediately once we learn of an infringement. Please send notices to the email address above.',
    ],
  },
  {
    heading: 'Liability for links',
    blocks: [
      'This service contains links to external third-party websites over whose content we have no influence. We can therefore accept no liability for that third-party content. The respective provider or operator of the linked pages is always responsible for their content. The linked pages were checked for possible legal violations at the time of linking; unlawful content was not apparent.',
      'Permanent monitoring of linked pages is unreasonable without concrete evidence of an infringement. We remove such links immediately once we learn of an infringement.',
    ],
  },
  {
    heading: 'Copyright',
    blocks: [
      'The content and works created by the operator on these pages are subject to German copyright law. Contributions by third parties are marked as such.',
      'Rights in the published release logs remain with their authors; whatever licence the respective repository states applies to them.',
    ],
  },
  {
    heading: 'Data protection',
    blocks: [
      'How this service handles personal data is described in the privacy policy at /datenschutz.',
    ],
  },
];

export const IMPRINT: Record<Locale, Section[]> = { de, en };

export const IMPRINT_META: Record<Locale, LegalMeta> = {
  de: {
    title: 'Impressum · release-log',
    description: 'Anbieterkennzeichnung nach § 5 DDG.',
    intro: 'Impressum',
    updated: 'Stand: {date}',
    back: 'Zur Startseite',
  },
  en: {
    title: 'Imprint · release-log',
    description: 'Provider identification under § 5 DDG.',
    intro: 'Imprint',
    updated: 'Last updated: {date}',
    back: 'Back to the start page',
  },
};
