import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Primitive crittografiche dell'autenticazione. Tutto con node:crypto, incluso
// in Node: nessuna dipendenza nuova.
//
//   - password:  hash scrypt salato, confronto a tempo costante
//   - sessioni:  token opaco a 256 bit; nel DB si salva solo il suo hash
//
// L'accesso è a un solo fattore (username + password): nessun TOTP/2FA.
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

// ----------------------------------------------------------- sessioni

/** Token di sessione opaco: 256 bit casuali, url-safe, per il cookie. */
export function nuovoTokenSessione(): string {
  return randomBytes(32).toString("base64url");
}

/** Hash del token: è QUESTO che finisce nel DB, mai il token in chiaro. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
