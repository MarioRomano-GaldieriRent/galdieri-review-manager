import { coll } from "./connessione";

// Le BOZZE: il testo che una persona ha scritto nel riquadro di una card senza
// ancora pubblicarlo. Si salva da solo mentre si scrive, così un ricarico, un
// auto-aggiornamento o un click andato storto non buttano via il lavoro.
//
// Una bozza per RECENSIONE (_id = chiave), non per persona: la coda è una sola
// e chi la lavora si alterna — se Stefania riscrive una risposta e poi la
// guarda Mario, deve vedere il testo di lei, non quello della regola.
//
// Vive finché la recensione non è pubblicata: `eliminaBozza` la toglie quando
// la risposta parte davvero, altrimenti una bozza vecchia ricomparirebbe sotto
// una recensione ormai gestita.

export type Bozza = {
  chiave: string;
  testo: string;
  operatoreId: number;
  salvataIl: string;
};

type DocBozza = {
  _id: string;
  testo: string;
  operatoreId: number;
  salvataIl: Date;
};

async function bozze() {
  return coll<DocBozza>("bozze");
}

function componi(d: DocBozza): Bozza {
  return {
    chiave: d._id,
    testo: d.testo,
    operatoreId: d.operatoreId,
    salvataIl: d.salvataIl.toISOString(),
  };
}

/** Le bozze delle recensioni in elenco, in una sola query. */
export async function bozzePer(chiavi: string[]): Promise<Map<string, Bozza>> {
  if (chiavi.length === 0) return new Map();
  const righe = await (await bozze()).find({ _id: { $in: chiavi } }).toArray();
  return new Map(righe.map((d) => [d._id, componi(d)]));
}

export async function leggiBozza(chiave: string): Promise<Bozza | null> {
  const d = await (await bozze()).findOne({ _id: chiave });
  return d ? componi(d) : null;
}

/**
 * Salva (o aggiorna) la bozza. Un testo vuoto NON lascia un documento vuoto in
 * giro: significa «ho cancellato tutto», e allora la bozza si toglie — così al
 * ricarico torna la proposta di partenza invece di un riquadro vuoto.
 */
export async function salvaBozza(chiave: string, testo: string, operatoreId: number): Promise<void> {
  const pulito = testo.trim();
  if (!pulito) {
    await eliminaBozza(chiave);
    return;
  }
  await (await bozze()).updateOne(
    { _id: chiave },
    { $set: { testo: pulito, operatoreId, salvataIl: new Date() } },
    { upsert: true },
  );
}

export async function eliminaBozza(chiave: string): Promise<void> {
  await (await bozze()).deleteOne({ _id: chiave });
}
