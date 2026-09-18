// Genau ein Geheimnis in diesem System wird benutzt statt geprüft: das
// GitHub-Nutzer-Token aus Entscheidung 23, das `create_log` für
// `POST /user/repos` braucht. Es liegt deshalb verschlüsselt statt gehasht
// -- und ist damit das Einzige, was ein Datenbankdiebstahl brauchbar
// erbeutet (spec §5). Alles andere, was dieser Dienst je speichert, ist ein
// Hash.
//
// AES-256-GCM, nicht CBC oder CTR: die Authentisierung gehört dazu. Eine
// veränderte Zeile soll auffallen, statt als Token benutzt zu werden.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12; // GCMs Standardgröße; alles andere kostet Kompatibilität ohne Gewinn
const KEY_BYTES = 32;
const VERSION = 'v1';

export type Cipher = {
  encrypt(plain: string): string;
  // null statt throw: eine Zeile, die sich nicht mehr entschlüsseln lässt
  // (Schlüssel gewechselt, Zeile verändert), ist kein Absturz, sondern ein
  // Konto, das sich einmal neu anmelden muss.
  decrypt(box: string): string | null;
};

// Der Schlüssel steht kodiert in der Umgebung, aus demselben Grund wie der
// private Schlüssel der App: 32 rohe Bytes sind keine .env-Zeile.
//
// Hex zuerst, weil der Schlüssel üblicherweise mit `openssl rand -hex 32`
// erzeugt wird -- ein bereits ausgerollter Schlüssel muss weiter gelten, sonst
// wäre jedes gespeicherte Nutzer-Token mit einem Deploy wertlos. Base64
// wird genauso gelesen, damit ein von Hand gesetzter Wert nicht an der
// Kodierung scheitert.
export function readEncryptionKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, hex- or base64-encoded');
  }
  return key;
}

export function cipher(key: Buffer): Cipher {
  return {
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES);
      const gcm = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([gcm.update(plain, 'utf8'), gcm.final()]);
      return [VERSION, iv.toString('base64url'), gcm.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
    },

    decrypt(box) {
      const parts = box.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) return null;
      try {
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        if (iv.length !== IV_BYTES) return null;
        const gcm = createDecipheriv('aes-256-gcm', key, iv);
        gcm.setAuthTag(tag);
        return Buffer.concat([gcm.update(Buffer.from(parts[3], 'base64url')), gcm.final()]).toString('utf8');
      } catch {
        // final() wirft, wenn das Authentisierungs-Tag nicht passt -- genau
        // der Fall, für den GCM da ist.
        return null;
      }
    },
  };
}
