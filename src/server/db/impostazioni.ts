import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Document } from "mongodb";
import { SCRITTURA_CRITICA, coll } from "./connessione";
import { eSegreta } from "./seed";

// Impostazioni: i valori normali nel documento impostazioni/_id="correnti", i
// segreti fuori dal database (nel .env, e in data/segreti.json se digitati dal
// pannello). Il .db... pardon, il database circola — lo si copia, lo si apre
// per guardare le statistiche — e una credenziale non deve poter comparire in
// una query fatta per curiosità. A impedirlo è un validator, non il codice.

const FILE_SEGRETI = path.join(process.cwd(), "data", "segreti.json");

export type Etichetta = {
  id: string;
  name: string;
  subjectContains: string;
  fromContains: string;
};

type DocCorrenti = {
  _id: "correnti";
  valori: { chiave: string; valore: string; aggiornataIl?: Date; aggiornataDa?: number }[];
  etichette: { id: string; nome: string; oggettoContiene: string; mittenteContiene: string }[];
  aggiornateIl: Date;
};

async function correnti(): Promise<DocCorrenti | null> {
  return (await coll<DocCorrenti>("impostazioni")).findOne({ _id: "correnti" });
}

// ------------------------------------------------------------ valori normali

export async function leggiValori(): Promise<Record<string, string>> {
  const doc = await correnti();
  const out: Record<string, string> = {};
  for (const v of doc?.valori ?? []) out[v.chiave] = v.valore;
  return out;
}

export async function leggiEtichette(): Promise<Etichetta[]> {
  const doc = await correnti();
  // L'ordine dell'array è quello semantico: etichette[0] è la principale.
  return (doc?.etichette ?? []).map((e) => ({
    id: e.id,
    name: e.nome,
    subjectContains: e.oggettoContiene ?? "",
    fromContains: e.mittenteContiene ?? "",
  }));
}

/**
 * Scrive lo snapshot completo: valori non segreti nel documento corrente,
 * segreti su file, storico dei cambiamenti (segreti compresi, ma senza valore).
 * Storico PRIMA delle correnti, come per le regole.
 */
export async function scriviImpostazioni(
  valori: Record<string, string>,
  etichette: Etichetta[],
  operatoreId = 1,
): Promise<void> {
  const ora = new Date();
  const precedenti = await leggiValori();

  const segreti: Record<string, string> = {};
  const normali: Record<string, string> = {};
  for (const [chiave, valore] of Object.entries(valori)) {
    if (!eSegreta(chiave)) {
      normali[chiave] = valore;
      continue;
    }
    // Su un campo segreto la stringa vuota significa "non toccarlo".
    if (valore.trim()) segreti[chiave] = valore;
  }

  // 1) storico dei valori normali cambiati
  const cambiamenti: Document[] = [];
  for (const [chiave, valore] of Object.entries(normali)) {
    if (precedenti[chiave] !== valore) {
      cambiamenti.push(rigaStorico(chiave, false, precedenti[chiave], valore, ora, operatoreId));
    }
  }
  if (cambiamenti.length > 0) {
    await (await coll("impostazioni_storico")).insertMany(cambiamenti, { writeConcern: SCRITTURA_CRITICA });
  }

  // 2) documento corrente riscritto per intero (keep() dipende dallo snapshot completo)
  await (await coll<DocCorrenti>("impostazioni")).replaceOne(
    { _id: "correnti" },
    {
      valori: Object.entries(normali).map(([chiave, valore]) => ({
        chiave,
        valore,
        aggiornataIl: ora,
        aggiornataDa: operatoreId,
      })),
      etichette: etichette.map((e) => ({
        id: e.id,
        nome: e.name,
        oggettoContiene: e.subjectContains ?? "",
        mittenteContiene: e.fromContains ?? "",
      })),
      aggiornateIl: ora,
    },
    { upsert: true },
  );

  // 3) i segreti stanno fuori dal database; nel database va solo la traccia
  if (Object.keys(segreti).length > 0) await scriviSegreti(segreti, ora, operatoreId);
}

function rigaStorico(
  chiave: string,
  segreto: boolean,
  prima: string | undefined,
  dopo: string,
  quando: Date,
  operatoreId: number,
): Document {
  const cePrima = Boolean(prima && prima.trim());
  const ceDopo = Boolean(dopo && dopo.trim());
  const doc: Document = {
    chiave,
    segreto,
    quando,
    operatoreId,
    azione: !ceDopo ? "svuotata" : cePrima ? "modificata" : "impostata",
    // Per i segreti: nessun valore, mai. È il validator a esigerlo, questo lo
    // rispetta a monte.
    valorePrecedente: segreto ? null : (prima ?? null),
    valoreNuovo: segreto ? null : dopo,
    presentePrima: cePrima,
    presenteDopo: ceDopo,
  };
  doc.sigillo = createHash("sha1").update(JSON.stringify(doc)).digest("hex");
  return doc;
}

// ------------------------------------------------------------------ segreti

/** RESTA SINCRONA: legge un file locale, non il database. */
export function leggiSegreti(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(FILE_SEGRETI, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && eSegreta(k)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function scriviSegreti(
  nuovi: Record<string, string>,
  quando: Date,
  operatoreId: number,
): Promise<void> {
  const precedenti = leggiSegreti();
  try {
    mkdirSync(path.dirname(FILE_SEGRETI), { recursive: true });
    writeFileSync(FILE_SEGRETI, JSON.stringify({ ...precedenti, ...nuovi }, null, 2), "utf8");
  } catch (e) {
    console.error("[impostazioni] segreti non salvati:", e);
    return;
  }

  const righe: Document[] = [];
  for (const [chiave, valore] of Object.entries(nuovi)) {
    if (precedenti[chiave] !== valore) {
      righe.push(rigaStorico(chiave, true, precedenti[chiave], valore, quando, operatoreId));
    }
  }
  if (righe.length > 0) {
    await (await coll("impostazioni_storico")).insertMany(righe, { writeConcern: SCRITTURA_CRITICA });
  }
}

// ------------------------------------------------------------------ storico

export type CambioImpostazione = {
  chiave: string;
  etichetta: string;
  segreto: boolean;
  quando: string;
  chi: string;
  azione: string;
  valorePrecedente: string | null;
  valoreNuovo: string | null;
  presentePrima: boolean;
  presenteDopo: boolean;
};

export async function storicoImpostazioni(limite = 100): Promise<CambioImpostazione[]> {
  const righe = await (await coll("impostazioni_storico"))
    .aggregate([
      { $sort: { quando: -1, _id: -1 } },
      { $limit: limite },
      { $lookup: { from: "impostazioni_catalogo", localField: "chiave", foreignField: "_id", as: "_c" } },
      { $lookup: { from: "operatori", localField: "operatoreId", foreignField: "_id", as: "_o" } },
    ])
    .toArray();

  return righe.map((r) => ({
    chiave: r.chiave as string,
    etichetta: (r._c?.[0]?.etichetta as string) ?? (r.chiave as string),
    segreto: Boolean(r.segreto),
    quando: (r.quando as Date).toISOString(),
    chi: (r._o?.[0]?.nome as string) ?? "Sistema",
    azione: r.azione as string,
    valorePrecedente: (r.valorePrecedente as string | null) ?? null,
    valoreNuovo: (r.valoreNuovo as string | null) ?? null,
    presentePrima: Boolean(r.presentePrima),
    presenteDopo: Boolean(r.presenteDopo),
  }));
}

export async function modoInVigoreDa(): Promise<string | null> {
  const r = await (await coll("impostazioni_storico"))
    .find({ chiave: "modo" })
    .sort({ quando: -1, _id: -1 })
    .limit(1)
    .next();
  return r ? (r.quando as Date).toISOString() : null;
}
