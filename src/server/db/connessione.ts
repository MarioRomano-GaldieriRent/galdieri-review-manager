import type { Collection, Db, Document, ObjectId } from "mongodb";
import { MongoClient } from "mongodb";

/**
 * Documento generico con _id NON forzato a ObjectId. Senza questo, i tipi del
 * driver assumono _id: ObjectId e rifiutano le nostre chiavi (stringa "correnti",
 * codice lingua, id numerico di versione). È il default di coll(): chi ha un
 * tipo preciso lo passa esplicitamente.
 */
export interface DocGen {
  _id?: string | number | ObjectId;
  [campo: string]: unknown;
}

// ---------------------------------------------------------------------------
// Connessione al database MongoDB locale (galdieri_recensioni).
//
// Il mongod è condiviso con un'altra applicazione (portale_assenze) e gira
// senza autenticazione: la guardia sul nome del database qui sotto è il
// presidio che impedisce, per un refuso, di scrivere nel database sbagliato.
//
// Solo codice server: server component, server action, script tsx. Mai un
// client component, mai una route con runtime "edge" (non ha i socket TCP).
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  throw new Error(
    "src/server/db non è importabile dal browser: contiene l'accesso al database e ai segreti.",
  );
}

// 127.0.0.1 e non "localhost": su Windows localhost risolve prima ::1 (IPv6) e
// il mongod ascolta su IPv4, con mezzo secondo di attesa a vuoto a ogni avvio.
const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const NOME_DB = process.env.MONGODB_DB ?? "galdieri_recensioni";

// Rete di sicurezza: il database di un'altra applicazione vive sullo stesso
// mongod, senza password. Un MONGODB_DB sbagliato non deve poter puntare lì.
if (["portale_assenze", "admin", "local", "config"].includes(NOME_DB)) {
  throw new Error(`MONGODB_DB=${NOME_DB}: non è il database di questa applicazione.`);
}

/** Scrittura che deve essere durevole prima di proseguire (storico, versioni). */
export const SCRITTURA_CRITICA = { w: "majority" as const, j: true, wtimeoutMS: 5000 };

/*
 * Singleton su globalThis. Si memorizza la PROMISE, non il client: due
 * richieste al primo avvio devono aspettare la stessa connessione, non
 * aprirne due. Senza singleton, in dev l'hot-reload apre un pool nuovo a ogni
 * salvataggio — misurati 10 client → 57 connessioni sul mongod.
 */
declare global {
  // eslint-disable-next-line no-var
  var __galdieriMongo: Promise<MongoClient> | undefined;
  // eslint-disable-next-line no-var
  var __galdieriChiusura: boolean | undefined;
}

function nuovoClient(): Promise<MongoClient> {
  const client = new MongoClient(URI, {
    serverSelectionTimeoutMS: 3000, // default 30s: mezzo minuto di pagina bianca se mongod è giù
    connectTimeoutMS: 3000,
    socketTimeoutMS: 20000, // default 0 = infinito: appenderebbe il worker per sempre
    maxPoolSize: process.env.NODE_ENV === "production" ? 20 : 5,
    minPoolSize: 0,
    retryWrites: false, // standalone: le scritture ritentabili non sono supportate
    ignoreUndefined: true, // undefined non deve finire come null a caso
    writeConcern: { w: "majority" }, // su standalone equivale a w:1, giusto anche per il futuro
  });

  return client.connect().catch((errore) => {
    // Una Promise rifiutata non deve restare incollata a globalThis, altrimenti
    // ogni richiesta successiva fallisce anche dopo che mongod è tornato su.
    globalThis.__galdieriMongo = undefined;
    throw new Error(`Impossibile connettersi a MongoDB su ${URI}`, { cause: errore });
  });
}

export function mongo(): Promise<MongoClient> {
  if (!globalThis.__galdieriMongo) {
    globalThis.__galdieriMongo = nuovoClient();
    registraChiusura();
  }
  return globalThis.__galdieriMongo;
}

export async function db(): Promise<Db> {
  return (await mongo()).db(NOME_DB);
}

export async function coll<T extends Document = DocGen>(nome: string): Promise<Collection<T>> {
  return (await db()).collection<T>(nome);
}

function registraChiusura(): void {
  if (globalThis.__galdieriChiusura) return;
  globalThis.__galdieriChiusura = true;
  // Solo alla chiusura del processo, MAI sull'hot-reload: dopo close() il
  // client è morto per sempre ("Client must be connected before running
  // operations"), e in dev il modulo viene rivalutato di continuo.
  const chiudi = async () => {
    const p = globalThis.__galdieriMongo;
    globalThis.__galdieriMongo = undefined;
    if (p) await (await p).close().catch(() => {});
  };
  process.once("SIGINT", chiudi);
  process.once("SIGTERM", chiudi);
}

// -------------------------------------------------------------- conversioni

/**
 * Da stringa ISO / Date a Date, o null. MongoDB conserva le date come tipo
 * proprio, quindi qui si convertono davvero — a differenza di SQLite dove
 * tutto era testo. null e undefined (e stringa vuota) diventano null.
 */
export function data(v: string | Date | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Testo sempre valorizzato: la stringa vuota è un valore, non un dato mancante. */
export const testo = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

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

/**
 * Riprova un'operazione una volta sola su errore transitorio di rete/timeout.
 * MongoDB standalone non ha le scritture ritentabili automatiche, e una
 * selezione del server può fallire per un attimo mentre il mongod è occupato.
 */
export async function conRiprova<T>(azione: () => Promise<T>, tentativi = 2): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i < tentativi; i++) {
    try {
      return await azione();
    } catch (e) {
      ultimo = e;
      const nome = (e as { name?: string }).name ?? "";
      // Solo gli errori transitori si ritentano; un errore di validazione o un
      // duplicato non migliora riprovando.
      if (!/MongoNetworkError|MongoServerSelectionError|MongoTimeoutError/.test(nome)) throw e;
      await new Promise((ok) => setTimeout(ok, 200 * (i + 1)));
    }
  }
  throw ultimo;
}

/** Stato della connessione, per la pagina statistiche e la verifica. */
export async function statoMongo(): Promise<{ ok: boolean; messaggio: string }> {
  try {
    await (await db()).command({ ping: 1 });
    return { ok: true, messaggio: `connesso a ${NOME_DB}` };
  } catch (e) {
    return { ok: false, messaggio: e instanceof Error ? e.message : "MongoDB non raggiungibile" };
  }
}

export { NOME_DB };
