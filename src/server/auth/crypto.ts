import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Primitive crittografiche dell'autenticazione. Tutto con node:crypto, incluso
// in Node: nessuna dipendenza nuova per la parte sensibile.
//
//   - password:      hash scrypt salato, confronto a tempo costante
//   - secret TOTP:   cifrato a riposo con AES-256-GCM (chiave da AUTH_ENC_KEY)
//   - TOTP:          RFC 6238, HMAC-SHA1, 6 cifre, passo 30s, deriva ±1
//   - sessioni:      token opaco a 256 bit; nel DB si salva solo il suo hash
//   - codici di recupero: generati in chiaro una volta, salvati come hash
//
// Solo codice server: node:crypto non esiste nel browser né nel runtime edge.
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  throw new Error("src/server/auth/crypto non è importabile dal browser: contiene i segreti.");
}

// -------------------------------------------------------------- confronti

/** Confronto a tempo costante fra due stringhe: non svela nulla dalla durata. */
export function confrontoCostante(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual esige lunghezze uguali: se differiscono la risposta è no,
  // ma si confronta comunque contro se stessi per non accorciare i tempi.
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// --------------------------------------------------------------- password

// Parametri scrypt: costo di CPU/memoria deliberato. 128*N*r ≈ 16 MiB per hash.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** Hash di una password, nel formato autoportante scrypt$N$r$p$salt$hash. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verifica una password contro l'hash salvato. false su qualunque formato rotto. */
export function verificaPassword(password: string, salvato: string): boolean {
  try {
    const parti = salvato.split("$");
    if (parti.length !== 6 || parti[0] !== "scrypt") return false;
    const [, n, r, p, saltHex, hashHex] = parti;
    const salt = Buffer.from(saltHex, "hex");
    const atteso = Buffer.from(hashHex, "hex");
    const calcolato = scryptSync(password, salt, atteso.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return atteso.length === calcolato.length && timingSafeEqual(atteso, calcolato);
  } catch {
    return false;
  }
}

// ----------------------------------------------------- cifratura a riposo

/**
 * Chiave AES a 256 bit, letta da AUTH_ENC_KEY (base64 o hex, 32 byte). La si
 * legge solo quando serve — cifrare/decifrare il secret TOTP — così l'app parte
 * anche senza, e a mancare è soltanto il secondo fattore, non tutto il login.
 */
function chiaveCifratura(): Buffer {
  const raw = process.env.AUTH_ENC_KEY ?? "";
  if (!raw) {
    throw new Error(
      "AUTH_ENC_KEY non impostata: serve per cifrare il secret TOTP. " +
        'Genera la chiave con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`AUTH_ENC_KEY non valida: attesi 32 byte, trovati ${buf.length}.`);
  }
  return buf;
}

/** Cifra un testo (il secret TOTP) → base64 di iv(12) | testo cifrato | tag(16). */
export function cifra(chiaro: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chiaveCifratura(), iv);
  const ct = Buffer.concat([cipher.update(chiaro, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/** Decifra ciò che ha prodotto cifra(). Lancia se il dato è manomesso. */
export function decifra(cifrato: string): string {
  const buf = Buffer.from(cifrato, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", chiaveCifratura(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** true se AUTH_ENC_KEY c'è ed è valida: per mostrare avvisi utili nell'UI. */
export function chiaveCifraturaPronta(): boolean {
  try {
    chiaveCifratura();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ base32 (TOTP)

const ALFABETO_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bit = 0;
  let valore = 0;
  let out = "";
  for (const byte of buf) {
    valore = (valore << 8) | byte;
    bit += 8;
    while (bit >= 5) {
      out += ALFABETO_B32[(valore >>> (bit - 5)) & 31];
      bit -= 5;
    }
  }
  if (bit > 0) out += ALFABETO_B32[(valore << (5 - bit)) & 31];
  return out;
}

function base32Decode(testo: string): Buffer {
  const pulito = testo.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bit = 0;
  let valore = 0;
  const byte: number[] = [];
  for (const ch of pulito) {
    const i = ALFABETO_B32.indexOf(ch);
    if (i === -1) throw new Error("carattere base32 non valido");
    valore = (valore << 5) | i;
    bit += 5;
    if (bit >= 8) {
      byte.push((valore >>> (bit - 8)) & 0xff);
      bit -= 8;
    }
  }
  return Buffer.from(byte);
}

// ---------------------------------------------------------------- TOTP

const TOTP_PASSO_S = 30;
const TOTP_CIFRE = 6;

/** Nuovo secret TOTP: 160 bit casuali in base32, come si aspettano le app. */
export function generaSegretoTotp(): string {
  return base32Encode(randomBytes(20));
}

/** Il codice TOTP per un dato contatore di passi (default: quello attuale). */
function codicePerPasso(segretoBase32: string, passo: number): string {
  const chiave = base32Decode(segretoBase32);
  const msg = Buffer.alloc(8);
  // Contatore a 64 bit big-endian; i primi 4 byte restano 0 fino al 2106.
  msg.writeUInt32BE(Math.floor(passo / 0x100000000), 0);
  msg.writeUInt32BE(passo >>> 0, 4);
  const hmac = createHmac("sha1", chiave).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** TOTP_CIFRE).toString().padStart(TOTP_CIFRE, "0");
}

/** Il codice valido in questo istante (per generare l'enrollment di prova). */
export function codiceTotpAttuale(segretoBase32: string): string {
  return codicePerPasso(segretoBase32, Math.floor(Date.now() / 1000 / TOTP_PASSO_S));
}

/**
 * Se il codice è valido, ritorna il NUMERO DI PASSO che ha fatto match (utile
 * per l'anti-replay: si rifiuta un passo già consumato), altrimenti null.
 * Accetta il passo attuale e i vicini ±finestra, per tollerare l'orologio
 * dell'app sfasato. Confronto a tempo costante; input non numerico o di
 * lunghezza sbagliata → null.
 */
export function passoTotpValido(segretoBase32: string, codice: string, finestra = 1): number | null {
  const pulito = (codice ?? "").replace(/\s/g, "");
  if (!new RegExp(`^\\d{${TOTP_CIFRE}}$`).test(pulito)) return null;
  const ora = Math.floor(Date.now() / 1000 / TOTP_PASSO_S);
  let passo: number | null = null;
  for (let d = -finestra; d <= finestra; d++) {
    // Nessun break anticipato: si scorrono tutti i passi per non far dipendere
    // la durata da quale sia quello giusto.
    if (confrontoCostante(codicePerPasso(segretoBase32, ora + d), pulito)) passo = ora + d;
  }
  return passo;
}

/** Come sopra, ma booleano: per gli usi che non tracciano il replay. */
export function verificaTotp(segretoBase32: string, codice: string, finestra = 1): boolean {
  return passoTotpValido(segretoBase32, codice, finestra) !== null;
}

/** L'URI otpauth:// da cui l'app authenticator legge il QR. */
export function otpauthUri(segretoBase32: string, account: string, emittente = "GaldieriReviews"): string {
  const etichetta = `${encodeURIComponent(emittente)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret: segretoBase32,
    issuer: emittente,
    algorithm: "SHA1",
    digits: String(TOTP_CIFRE),
    period: String(TOTP_PASSO_S),
  });
  return `otpauth://totp/${etichetta}?${q}`;
}

// ----------------------------------------------------------- sessioni

/** Token di sessione opaco: 256 bit casuali, url-safe, per il cookie. */
export function nuovoTokenSessione(): string {
  return randomBytes(32).toString("base64url");
}

/** Hash del token: è QUESTO che finisce nel DB, mai il token in chiaro. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// -------------------------------------------------- codici di recupero

/** Normalizza un codice di recupero per confronto e hash: minuscolo, senza separatori. */
function normalizzaCodiceRecupero(codice: string): string {
  return codice.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * n codici di recupero in chiaro, mostrati una sola volta. ~80 bit di entropia
 * ciascuno (randomBytes(10)): con così tanto spazio, anche un hash veloce e
 * senza sale non è forzabile offline. Formato a gruppi di 5 per leggibilità.
 */
export function generaCodiciRecupero(n = 10): string[] {
  const codici: string[] = [];
  for (let i = 0; i < n; i++) {
    const hex = randomBytes(10).toString("hex"); // 20 caratteri, ~80 bit
    codici.push(`${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}-${hex.slice(15, 20)}`);
  }
  return codici;
}

/** Hash sha256 di un codice di recupero, come va salvato. */
export function hashCodiceRecupero(codice: string): string {
  return createHash("sha256").update(normalizzaCodiceRecupero(codice)).digest("hex");
}
