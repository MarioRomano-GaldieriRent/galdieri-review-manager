import type { AnyBulkWriteOperation, Document } from "mongodb";
import { coll } from "./connessione";

// ---------------------------------------------------------------------------
// MEMORIA: ciò che il modello "sa" quando genererà una risposta.
//
//   memoria_contesto — blocchi di testo (chi siamo, tono, regole), curati a mano
//   memoria_esempi   — le risposte VERE scritte da Stefania negli ultimi mesi,
//                      ognuna con la recensione a cui rispondeva; raggruppabili
//                      per tipo (positiva con/senza testo, neutra, negativa) e
//                      lingua, e accendibili/spegnibili una a una o a gruppi
//
// Il pannello /memoria le mostra e le cura; l'importazione (server/memoria/
// importa.ts) le riempie dalla Posta inviata.
// ---------------------------------------------------------------------------

export type TipoEsempio =
  "positiva-con-testo" | "positiva-senza-testo" | "neutra" | "negativa" | "senza-recensione";
export type LinguaEsempio = "it" | "en" | "altro";
export type OrigineEsempio = "stefania" | "customer-care";
export type StatoFiltro = "tutte" | "attive" | "escluse";

/** Ordine e nomi dei tipi, come li mostra il pannello. */
export const TIPI: { id: TipoEsempio; nome: string; descrizione: string }[] = [
  {
    id: "positiva-con-testo",
    nome: "Positive con commento",
    descrizione: "4–5★ con testo: il ringraziamento personalizzato (il grosso del lavoro)",
  },
  {
    id: "positiva-senza-testo",
    nome: "Positive senza commento",
    descrizione: "4–5★ solo punteggio",
  },
  { id: "neutra", nome: "Neutre (3★)", descrizione: "" },
  {
    id: "negativa",
    nome: "Negative (1–2★)",
    descrizione:
      "solo le risposte scritte direttamente da Stefania; quelle rimandate dal customer care nascono escluse",
  },
  {
    id: "senza-recensione",
    nome: "Senza recensione riconosciuta",
    descrizione: "risposte di cui non si è ricostruita la recensione: nascono escluse",
  },
];

export const LINGUE: { id: LinguaEsempio; nome: string }[] = [
  { id: "it", nome: "Italiano" },
  { id: "en", nome: "Inglese" },
  { id: "altro", nome: "Altro" },
];

export function parseTipo(s: string | undefined): TipoEsempio | undefined {
  return TIPI.some((t) => t.id === s) ? (s as TipoEsempio) : undefined;
}
export function parseLingua(s: string | undefined): LinguaEsempio | undefined {
  return LINGUE.some((l) => l.id === s) ? (s as LinguaEsempio) : undefined;
}
export function parseStato(s: string | undefined): StatoFiltro {
  return s === "attive" || s === "escluse" ? s : "tutte";
}

// ------------------------------------------------------------------ esempi

export type Esempio = {
  chiave: string;
  conversationId: string;
  tipo: TipoEsempio;
  stelle: number | null;
  lingua: LinguaEsempio;
  sedeNome: string;
  nomeCliente: string;
  commento: string;
  risposta: string;
  inviataIl: string;
  origine: OrigineEsempio;
  attivo: boolean;
  nota: string;
  importataIl: string;
};

type DocEsempio = {
  _id: string;
  conversationId: string;
  tipo: TipoEsempio;
  stelle: number | null;
  lingua: LinguaEsempio;
  sedeNome: string;
  nomeCliente: string;
  commento: string;
  risposta: string;
  inviataIl: Date;
  origine: OrigineEsempio;
  attivo: boolean;
  eliminata: boolean;
  nota: string;
  importataIl: Date;
  creataIl: Date;
  aggiornataIl: Date;
};

/** Una voce come la produce l'importazione (prima di sapere se esiste già). */
export type EsempioDaImportare = {
  chiave: string;
  conversationId: string;
  tipo: TipoEsempio;
  stelle: number | null;
  lingua: LinguaEsempio;
  sedeNome: string;
  nomeCliente: string;
  commento: string;
  risposta: string;
  inviataIl: Date;
  origine: OrigineEsempio;
  /** Vale SOLO alla prima importazione: dopo comanda il pannello. */
  attivoIniziale: boolean;
};

export type FiltriEsempi = {
  tipo?: TipoEsempio;
  lingua?: LinguaEsempio;
  sede?: string;
  q?: string;
  stato?: StatoFiltro;
};

async function esempi() {
  return coll<DocEsempio>("memoria_esempi");
}

function componiEsempio(d: DocEsempio): Esempio {
  return {
    chiave: d._id,
    conversationId: d.conversationId,
    tipo: d.tipo,
    stelle: d.stelle,
    lingua: d.lingua,
    sedeNome: d.sedeNome,
    nomeCliente: d.nomeCliente,
    commento: d.commento,
    risposta: d.risposta,
    inviataIl: d.inviataIl.toISOString(),
    origine: d.origine,
    attivo: d.attivo,
    nota: d.nota,
    importataIl: d.importataIl.toISOString(),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function query(f: FiltriEsempi): Document {
  const q: Document = { eliminata: false };
  if (f.tipo) q.tipo = f.tipo;
  if (f.lingua) q.lingua = f.lingua;
  if (f.stato === "attive") q.attivo = true;
  else if (f.stato === "escluse") q.attivo = false;
  if (f.sede) q.sedeNome = { $regex: escapeRe(f.sede), $options: "i" };
  if (f.q) {
    const re = { $regex: escapeRe(f.q), $options: "i" };
    q.$or = [{ nomeCliente: re }, { commento: re }, { risposta: re }, { sedeNome: re }];
  }
  return q;
}

/**
 * Inserisce o aggiorna in blocco le voci importate. I campi ricavati dalla
 * posta si riallineano sempre; `attivo`/`eliminata`/`nota` si fissano SOLO alla
 * nascita: dopo comanda il pannello, e una re-importazione non li tocca.
 */
export async function upsertEsempi(
  voci: EsempioDaImportare[],
): Promise<{ nuove: number; aggiornate: number }> {
  if (voci.length === 0) return { nuove: 0, aggiornate: 0 };
  const c = await esempi();
  const ora = new Date();
  const ops: AnyBulkWriteOperation<DocEsempio>[] = voci.map((v) => ({
    updateOne: {
      filter: { _id: v.chiave },
      update: {
        $set: {
          conversationId: v.conversationId,
          tipo: v.tipo,
          stelle: v.stelle,
          lingua: v.lingua,
          sedeNome: v.sedeNome,
          nomeCliente: v.nomeCliente,
          commento: v.commento,
          risposta: v.risposta,
          inviataIl: v.inviataIl,
          origine: v.origine,
          importataIl: ora,
          aggiornataIl: ora,
        },
        $setOnInsert: { attivo: v.attivoIniziale, eliminata: false, nota: "", creataIl: ora },
      },
      upsert: true,
    },
  }));

  let nuove = 0;
  let aggiornate = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const r = await c.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    nuove += r.upsertedCount;
    aggiornate += r.matchedCount;
  }
  return { nuove, aggiornate };
}

/**
 * Svuota gli esempi (NON i blocchi di contesto). Cancella anche le scelte
 * fatte nel pannello: serve solo per rifare da zero una prima importazione.
 */
export async function azzeraEsempi(): Promise<number> {
  const r = await (await esempi()).deleteMany({});
  return r.deletedCount;
}

/** Numeri di testata del pannello. */
export async function riepilogoEsempi(): Promise<{
  totale: number;
  attive: number;
  escluse: number;
  daCustomerCare: number;
  dal: string | null;
  al: string | null;
}> {
  const c = await esempi();
  const [r] = await c
    .aggregate<{
      totale: number;
      attive: number;
      daCustomerCare: number;
      dal: Date | null;
      al: Date | null;
    }>([
      { $match: { eliminata: false } },
      {
        $group: {
          _id: null,
          totale: { $sum: 1 },
          attive: { $sum: { $cond: ["$attivo", 1, 0] } },
          daCustomerCare: { $sum: { $cond: [{ $eq: ["$origine", "customer-care"] }, 1, 0] } },
          dal: { $min: "$inviataIl" },
          al: { $max: "$inviataIl" },
        },
      },
    ])
    .toArray();
  if (!r) return { totale: 0, attive: 0, escluse: 0, daCustomerCare: 0, dal: null, al: null };
  return {
    totale: r.totale,
    attive: r.attive,
    escluse: r.totale - r.attive,
    daCustomerCare: r.daCustomerCare,
    dal: r.dal ? r.dal.toISOString() : null,
    al: r.al ? r.al.toISOString() : null,
  };
}

/** Conteggi per tipo × lingua (rispettando i filtri), per la vista a gruppi. */
export async function contaGruppi(
  f: FiltriEsempi,
): Promise<{ tipo: TipoEsempio; lingua: LinguaEsempio; n: number; attive: number }[]> {
  const c = await esempi();
  const righe = await c
    .aggregate<{ _id: { tipo: TipoEsempio; lingua: LinguaEsempio }; n: number; attive: number }>([
      { $match: query(f) },
      {
        $group: {
          _id: { tipo: "$tipo", lingua: "$lingua" },
          n: { $sum: 1 },
          attive: { $sum: { $cond: ["$attivo", 1, 0] } },
        },
      },
    ])
    .toArray();
  return righe.map((r) => ({ tipo: r._id.tipo, lingua: r._id.lingua, n: r.n, attive: r.attive }));
}

/** Elenco paginato (dalla più recente), rispettando i filtri. */
export async function elencoEsempi(
  f: FiltriEsempi,
  pag: { pagina: number; perPagina: number },
): Promise<{ voci: Esempio[]; totale: number }> {
  const c = await esempi();
  const q = query(f);
  const totale = await c.countDocuments(q);
  const skip = Math.max(0, pag.pagina - 1) * pag.perPagina;
  const righe = await c.find(q).sort({ inviataIl: -1 }).skip(skip).limit(pag.perPagina).toArray();
  return { voci: righe.map(componiEsempio), totale };
}

export async function impostaAttivoEsempio(chiave: string, attivo: boolean): Promise<boolean> {
  const r = await (
    await esempi()
  ).updateOne({ _id: chiave, eliminata: false }, { $set: { attivo, aggiornataIl: new Date() } });
  return r.matchedCount > 0;
}

/** Includi/escludi tutte le voci che rispondono ai filtri. Ritorna quante ha toccato. */
export async function impostaAttivoGruppo(f: FiltriEsempi, attivo: boolean): Promise<number> {
  const r = await (
    await esempi()
  ).updateMany({ ...query(f), attivo: !attivo }, { $set: { attivo, aggiornataIl: new Date() } });
  return r.modifiedCount;
}

/** Soft delete: sparisce dal pannello e dal contesto, e non torna alla prossima importazione. */
export async function eliminaEsempio(chiave: string): Promise<boolean> {
  const r = await (
    await esempi()
  ).updateOne(
    { _id: chiave },
    { $set: { eliminata: true, attivo: false, aggiornataIl: new Date() } },
  );
  return r.matchedCount > 0;
}

/**
 * Gli esempi che entrano davvero nel contesto (attivi, non eliminati), i più
 * recenti prima. È la lettura che userà la generazione delle risposte.
 */
export async function esempiPerContesto(opts: {
  tipo?: TipoEsempio;
  lingua?: LinguaEsempio;
  limite: number;
  /** Chiavi da NON usare come esempio (es. la recensione stessa, in un banco di prova). */
  escludi?: string[];
}): Promise<Esempio[]> {
  const q: Document = { eliminata: false, attivo: true };
  if (opts.tipo) q.tipo = opts.tipo;
  if (opts.lingua) q.lingua = opts.lingua;
  if (opts.escludi?.length) q._id = { $nin: opts.escludi };
  const righe = await (await esempi()).find(q).sort({ inviataIl: -1 }).limit(opts.limite).toArray();
  return righe.map(componiEsempio);
}

// ---------------------------------------------------------------- contesto

export type Blocco = {
  chiave: string;
  titolo: string;
  testo: string;
  attivo: boolean;
  ordine: number;
  aggiornataIl: string;
};

type DocBlocco = {
  _id: string;
  titolo: string;
  testo: string;
  attivo: boolean;
  ordine: number;
  creataIl: Date;
  aggiornataIl: Date;
};

async function blocchi() {
  return coll<DocBlocco>("memoria_contesto");
}

function componiBlocco(d: DocBlocco): Blocco {
  return {
    chiave: d._id,
    titolo: d.titolo,
    testo: d.testo,
    attivo: d.attivo,
    ordine: d.ordine,
    aggiornataIl: d.aggiornataIl.toISOString(),
  };
}

/** Bozze iniziali: si creano solo se non c'è ancora nessun blocco. Modificabili dal pannello. */
const SEME_CONTESTO: { chiave: string; titolo: string; testo: string }[] = [
  {
    chiave: "chi-siamo",
    titolo: "Chi siamo e tono di voce",
    testo:
      "Siamo Galdieri rent, autonoleggio con sedi in tutta Italia (aeroporti, stazioni, città). Rispondiamo alle recensioni Google a nome di Galdieri rent, in prima persona plurale.\n" +
      "Tono: cordiale, professionale, sintetico, mai formale in eccesso. Diamo del Lei. Chiudiamo con un saluto e la firma «Galdieri rent».",
  },
  {
    chiave: "regole",
    titolo: "Regole di risposta",
    testo:
      "- Rispondi nella lingua del cliente: italiano se ha scritto in italiano, altrimenti inglese.\n" +
      "- Ringrazia sempre per il tempo dedicato alla recensione; se il cliente cita una persona o la sede, riprendilo.\n" +
      "- Positive: personalizza sul contenuto del commento, senza frasi fatte identiche per tutti.\n" +
      "- Negative: dispiacere sincero e breve, niente giustificazioni lunghe, invito a contattare il customer care per approfondire. Mai promettere rimborsi o azioni specifiche.\n" +
      "- Mai dati personali, mai polemica, mai promesse che non possiamo mantenere.",
  },
];

export async function seedContestoSeVuoto(): Promise<void> {
  const c = await blocchi();
  if ((await c.countDocuments({})) > 0) return;
  const ora = new Date();
  await c.insertMany(
    SEME_CONTESTO.map((s, i) => ({
      _id: s.chiave,
      titolo: s.titolo,
      testo: s.testo,
      attivo: true,
      ordine: i + 1,
      creataIl: ora,
      aggiornataIl: ora,
    })),
  );
}

export async function elencoBlocchi(): Promise<Blocco[]> {
  const righe = await (await blocchi()).find({}).sort({ ordine: 1 }).toArray();
  return righe.map(componiBlocco);
}

/** Solo i blocchi accesi, in ordine: è ciò che entrerà nel prompt. */
export async function blocchiPerContesto(): Promise<Blocco[]> {
  const righe = await (await blocchi()).find({ attivo: true }).sort({ ordine: 1 }).toArray();
  return righe.map(componiBlocco);
}

export async function creaBlocco(titolo: string, testo: string): Promise<string> {
  const c = await blocchi();
  const ultimo = await c.find({}).sort({ ordine: -1 }).limit(1).toArray();
  const ordine = (ultimo[0]?.ordine ?? 0) + 1;
  const ora = new Date();
  const chiave = `b-${ora.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  await c.insertOne({
    _id: chiave,
    titolo,
    testo,
    attivo: true,
    ordine,
    creataIl: ora,
    aggiornataIl: ora,
  });
  return chiave;
}

export async function aggiornaBlocco(
  chiave: string,
  dati: { titolo: string; testo: string },
): Promise<boolean> {
  const r = await (
    await blocchi()
  ).updateOne(
    { _id: chiave },
    { $set: { titolo: dati.titolo, testo: dati.testo, aggiornataIl: new Date() } },
  );
  return r.matchedCount > 0;
}

export async function impostaAttivoBlocco(chiave: string, attivo: boolean): Promise<boolean> {
  const r = await (
    await blocchi()
  ).updateOne({ _id: chiave }, { $set: { attivo, aggiornataIl: new Date() } });
  return r.matchedCount > 0;
}

export async function eliminaBlocco(chiave: string): Promise<boolean> {
  const r = await (await blocchi()).deleteOne({ _id: chiave });
  return r.deletedCount > 0;
}
