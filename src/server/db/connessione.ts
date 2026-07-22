import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applicaMigrazioni } from "./schema";

// ---------------------------------------------------------------------------
// Apertura del database locale (data/galdieri.db) con il modulo built-in
// `node:sqlite`. Nessuna dipendenza npm: better-sqlite3 non si compila su
// questa macchina (nessun binario per Node 23, manca il toolchain MSVC).
//
// Solo codice server: server component, server action, script tsx. Mai un
// client component, mai una route con runtime "edge".
// ---------------------------------------------------------------------------

// Guardia esplicita al posto di `import "server-only"`, che non è installato e
// sarebbe una dipendenza nuova. Se questo modulo finisse per sbaglio in un
// bundle client, l'errore è immediato e dice cosa è successo.
if (typeof window !== "undefined") {
  throw new Error(
    "src/server/db non è importabile dal browser: contiene l'accesso al database e ai segreti.",
  );
}

/** Percorso del file. Sovrascrivibile per i test con GALDIERI_DB_PATH. */
export const PERCORSO_DB =
  process.env.GALDIERI_DB_PATH ?? path.join(process.cwd(), "data", "galdieri.db");

/** Millisecondi di attesa quando il file è occupato da un altro processo. */
const ATTESA_LOCK_MS = 5000;

/*
 * In sviluppo Next rivaluta i moduli a ogni salvataggio: senza singleton su
 * globalThis ogni ricarica aprirebbe una connessione nuova e le vecchie
 * resterebbero appese tenendo un lock. Non fallisce subito — fallisce dopo,
 * come "database is locked" intermittente, che è molto peggio da diagnosticare.
 * globalThis sopravvive all'hot-reload.
 */
declare global {
  // eslint-disable-next-line no-var
  var __galdieriDb: DatabaseSync | undefined;
  // eslint-disable-next-line no-var
  var __galdieriProfonditaTx: number | undefined;
  // eslint-disable-next-line no-var
  var __galdieriChiusuraRegistrata: boolean | undefined;
  // eslint-disable-next-line no-var
  var __galdieriAvviato: boolean | undefined;
}

/** Funzione chiamata una volta sola dopo le migrazioni: semina e travaso. */
let dopoApertura: ((c: DatabaseSync) => void) | null = null;

/**
 * Registra il lavoro di avvio (semina + travaso dai JSON). Sta qui e non
 * dentro db() per non creare un ciclo di import: avvio.ts importa questo
 * modulo, non il contrario.
 */
export function registraAvvio(f: (c: DatabaseSync) => void): void {
  dopoApertura = f;
}

/**
 * La connessione condivisa, aperta al primo uso.
 *
 * È sincrona di proposito: `node:sqlite` non ha API asincrone, e restando
 * sincrona l'inizializzazione non può essere interrotta a metà da un'altra
 * richiesta — niente doppia apertura, niente migrazioni applicate due volte.
 */
export function db(): DatabaseSync {
  const esistente = globalThis.__galdieriDb;
  if (esistente) return esistente;

  // Al primo avvio data/ può non esistere: senza questa riga node:sqlite dice
  // "unable to open database file" senza nominare il percorso, e si finisce a
  // cercare un problema di permessi che non c'è.
  mkdirSync(path.dirname(PERCORSO_DB), { recursive: true });

  let connessione: DatabaseSync;
  try {
    connessione = new DatabaseSync(PERCORSO_DB);
  } catch (errore) {
    throw new Error(`Impossibile aprire il database ${PERCORSO_DB}`, { cause: errore });
  }

  try {
    configura(connessione);
    applicaMigrazioni(connessione);
  } catch (errore) {
    // Non lasciare in giro una connessione mezza inizializzata.
    try {
      connessione.close();
    } catch {
      /* già chiusa */
    }
    throw errore;
  }

  globalThis.__galdieriDb = connessione;
  globalThis.__galdieriProfonditaTx = 0;
  registraChiusura();

  // Semina e travaso: dopo che la connessione è registrata, altrimenti le
  // funzioni che chiamano db() al loro interno rientrerebbero qui in loop.
  if (dopoApertura && !globalThis.__galdieriAvviato) {
    globalThis.__galdieriAvviato = true;
    try {
      dopoApertura(connessione);
    } catch (errore) {
      // L'avvio non deve impedire di usare l'applicazione: se la semina o il
      // travaso falliscono si lavora comunque, con un messaggio in console.
      console.error("[db] avvio non completato:", errore);
    }
  }

  return connessione;
}

function configura(connessione: DatabaseSync): void {
  // ATTENZIONE: l'opzione `{ timeout }` del costruttore è dichiarata nei tipi
  // di @types/node ma su Node 23 viene ignorata in silenzio — busy_timeout
  // resta 0 e qualunque contesa fallisce all'istante. Solo il PRAGMA funziona.
  connessione.exec(`PRAGMA busy_timeout = ${ATTESA_LOCK_MS}`);
  // WAL: letture e scritture non si bloccano a vicenda. È ciò che permette a
  // `npm run analisi` di girare mentre `next dev` è acceso.
  connessione.exec("PRAGMA journal_mode = WAL");
  connessione.exec("PRAGMA synchronous = NORMAL");
  // Da abilitare per connessione e FUORI da una transazione: dentro sarebbe un
  // no-op silenzioso, cioè l'illusione di avere i vincoli attivi.
  connessione.exec("PRAGMA foreign_keys = ON");
}

function registraChiusura(): void {
  if (globalThis.__galdieriChiusuraRegistrata) return;
  globalThis.__galdieriChiusuraRegistrata = true;
  // Chiudere in uscita fa il checkpoint del WAL e rimuove i file -wal e -shm.
  process.once("exit", () => chiudiDb());
}

/** Chiude la connessione. Serve agli script; in Next non va chiamata. */
export function chiudiDb(): void {
  const connessione = globalThis.__galdieriDb;
  if (!connessione) return;
  globalThis.__galdieriDb = undefined;
  globalThis.__galdieriProfonditaTx = 0;
  try {
    connessione.close();
  } catch {
    /* già chiusa */
  }
}

// ------------------------------------------------------------- transazioni

/**
 * Esegue `azione` dentro una transazione, annidabile tramite SAVEPOINT.
 *
 * `azione` DEVE essere sincrona. La connessione è una sola e condivisa: un
 * await a metà transazione lascerebbe entrare altre richieste dentro la stessa
 * transazione, e verrebbero confermate o annullate insieme a questa. È
 * corruzione logica senza nessun errore, quindi il caso viene intercettato.
 */
export function transazione<T>(azione: () => T): T {
  const connessione = db();
  const profondita = globalThis.__galdieriProfonditaTx ?? 0;
  const punto = `salvataggio_${profondita}`;

  connessione.exec(profondita === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${punto}`);
  globalThis.__galdieriProfonditaTx = profondita + 1;

  let esito: T;
  try {
    esito = azione();
  } catch (errore) {
    globalThis.__galdieriProfonditaTx = profondita;
    annulla(connessione, profondita, punto);
    throw errore;
  }

  if (esito !== null && typeof (esito as { then?: unknown })?.then === "function") {
    globalThis.__galdieriProfonditaTx = profondita;
    annulla(connessione, profondita, punto);
    throw new TypeError(
      "transazione() richiede una funzione sincrona: node:sqlite non ha API asincrone e " +
        "un await interno farebbe finire altre richieste dentro questa stessa transazione.",
    );
  }

  globalThis.__galdieriProfonditaTx = profondita;
  connessione.exec(profondita === 0 ? "COMMIT" : `RELEASE ${punto}`);
  return esito;
}

function annulla(connessione: DatabaseSync, profondita: number, punto: string): void {
  // Senza questo ROLLBACK la connessione condivisa resterebbe "dentro una
  // transazione" per sempre, e ogni richiesta successiva fallirebbe con
  // "cannot start a transaction within a transaction".
  try {
    if (profondita === 0) connessione.exec("ROLLBACK");
    else connessione.exec(`ROLLBACK TO ${punto}; RELEASE ${punto}`);
  } catch {
    /* SQLite può aver già annullato la transazione da sé */
  }
}

// -------------------------------------------------------------- conversioni
// node:sqlite accetta soltanto null, number, bigint, string e Uint8Array.

export type ValoreBindabile = null | number | bigint | string | Uint8Array;

/**
 * Rende bindabile un valore JavaScript.
 *
 *   undefined -> NULL   (undefined da solo solleva TypeError)
 *   boolean   -> 0 / 1  (i boolean sollevano TypeError)
 *   Date      -> ISO    senza questa conversione una Date verrebbe scritta
 *                       come NULL SENZA nessun errore: perdita silenziosa.
 */
export function val(valore: unknown): ValoreBindabile {
  if (valore === undefined || valore === null) return null;
  if (typeof valore === "boolean") return valore ? 1 : 0;
  if (valore instanceof Date) {
    return Number.isNaN(valore.getTime()) ? null : valore.toISOString();
  }
  if (
    typeof valore === "string" ||
    typeof valore === "number" ||
    typeof valore === "bigint" ||
    valore instanceof Uint8Array
  ) {
    return valore;
  }
  throw new TypeError(
    `Valore non scrivibile su SQLite (${Object.prototype.toString.call(valore)}). ` +
      "Per oggetti e array usa json().",
  );
}

/** Testo sempre valorizzato: la stringa vuota è un valore, non un dato mancante. */
export const testo = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** 0/1 da un booleano, per le colonne con CHECK (x IN (0,1)). */
export const bit = (v: unknown): number => (v ? 1 : 0);

export const daBit = (v: unknown): boolean => v === 1 || v === 1n;

export function json(valore: unknown): string {
  return JSON.stringify(valore ?? null);
}

export function daJson<T>(valore: unknown, predefinito: T): T {
  if (typeof valore !== "string" || valore === "") return predefinito;
  try {
    return JSON.parse(valore) as T;
  } catch {
    return predefinito;
  }
}

// ------------------------------------------------------------------ lettura
//
// node:sqlite restituisce righe con prototipo null. React le rifiuta quando
// passano da un server component a un client component ("Classes or null
// prototypes are not supported"), mentre JSON.stringify funziona: il problema
// sfugge ai test e si vede solo in faccia all'utente. Nessuna riga grezza esce
// da qui.

export function unaRiga<T extends object = Record<string, unknown>>(
  sql: string,
  ...parametri: ValoreBindabile[]
): T | undefined {
  const riga = db()
    .prepare(sql)
    .get(...parametri);
  return riga === undefined ? undefined : ({ ...riga } as T);
}

export function tutteLeRighe<T extends object = Record<string, unknown>>(
  sql: string,
  ...parametri: ValoreBindabile[]
): T[] {
  return db()
    .prepare(sql)
    .all(...parametri)
    .map((riga) => ({ ...riga }) as T);
}

/** INSERT / UPDATE / DELETE. */
export function esegui(sql: string, ...parametri: ValoreBindabile[]) {
  return db()
    .prepare(sql)
    .run(...parametri);
}

/** Numero singolo da una COUNT/SUM. Zero se la query non torna nulla. */
export function conta(sql: string, ...parametri: ValoreBindabile[]): number {
  const riga = unaRiga<Record<string, unknown>>(sql, ...parametri);
  if (!riga) return 0;
  const primo = Object.values(riga)[0];
  return typeof primo === "number" ? primo : Number(primo ?? 0);
}
