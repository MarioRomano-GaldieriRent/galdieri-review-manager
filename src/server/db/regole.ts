import { createHash } from "node:crypto";
import type { Document } from "mongodb";
import { SCRITTURA_CRITICA, coll } from "./connessione";
import type { Azione, Regola } from "@/server/automation/types";

// Le regole: stato corrente nel documento unico regole/_id="correnti", storico
// immutabile nella collezione regole_versioni.
//
// L'immutabilità delle versioni non è più imposta dal motore (MongoDB non ha
// trigger): la difesa è che questo modulo NON contiene alcun updateOne /
// deleteOne / replaceOne su regole_versioni — solo insertOne — più un sigillo
// (sha1 del documento) che verifica-db.ts ricalcola. È un passaggio da
// prevenzione a rilevamento, ed è messo per iscritto.

export type Origine = "iniziale" | "interfaccia" | "ripristino" | "importazione";

/** Impronta del contenuto: serve a NON creare una versione se non è cambiato niente. RESTA SINCRONA. */
export function improntaRegola(r: Regola): string {
  const canonico = JSON.stringify({
    nome: r.nome,
    attiva: r.attiva,
    stelle: [...r.condizione.stelle].sort((a, b) => a - b),
    testo: r.condizione.testo,
    azioni: r.azioni.map((a) => ({
      id: a.id,
      tipo: a.tipo,
      parametri: Object.keys(a.parametri)
        .sort()
        .map((k) => [k, a.parametri[k]]),
    })),
  });
  return createHash("sha1").update(canonico).digest("hex");
}

/** Sigillo del documento di versione: rileva una modifica fatta aggirando il codice. */
function sigilla(doc: Document): string {
  const { sigillo, ...resto } = doc;
  void sigillo;
  return createHash("sha1").update(JSON.stringify(resto)).digest("hex");
}

type DocRegole = {
  _id: "correnti";
  regole: Regola[];
  aggiornateIl: Date;
  aggiornateDa: number;
};

// ------------------------------------------------------------------ lettura

export async function leggiRegole(): Promise<Regola[]> {
  const doc = await (await coll<DocRegole>("regole")).findOne({ _id: "correnti" });
  return doc?.regole ?? [];
}

// ---------------------------------------------------------------- scrittura

/**
 * Riscrive lo stato corrente e registra una versione per ogni regola cambiata.
 *
 * Ordine obbligatorio: PRIMA le versioni, POI il documento corrente. Se il
 * secondo passo fallisce la storia è salva e il salvataggio successivo si
 * autoripara per deduplica di impronta. Nell'ordine opposto un salvataggio
 * interrotto cancellerebbe per sempre un pezzo di storia.
 */
export async function scriviRegole(
  regole: Regola[],
  origine: Origine = "interfaccia",
  nota = "",
): Promise<void> {
  const versioni = await coll("regole_versioni");
  const ora = new Date();

  // Stato precedente, per decidere cosa è cambiato e che tipo di modifica è.
  const ultime = new Map<string, { impronta: string; attiva: boolean }>();
  for (const v of await versioni
    .aggregate([
      { $sort: { regolaId: 1, numero: -1 } },
      { $group: { _id: "$regolaId", impronta: { $first: "$impronta" }, attiva: { $first: "$attiva" } } },
    ])
    .toArray()) {
    ultime.set(v._id as string, { impronta: v.impronta as string, attiva: v.attiva as boolean });
  }

  for (const r of regole) {
    const impronta = improntaRegola(r);
    const prima = ultime.get(r.id);
    if (prima?.impronta === impronta) continue; // niente di cambiato: nessuna versione

    const soloStato = prima !== undefined && prima.attiva !== r.attiva;
    const tipoModifica =
      origine === "ripristino"
        ? "ripristino"
        : prima === undefined
          ? "creazione"
          : soloStato
            ? "stato"
            : "contenuto";

    await inserisciVersione(r, impronta, tipoModifica, origine, nota, ora);
  }

  // Solo dopo che le versioni sono al sicuro si aggiorna lo stato corrente.
  // L'_id non va nel documento di sostituzione: su upsert lo prende dal filtro.
  await (await coll<DocRegole>("regole")).replaceOne(
    { _id: "correnti" },
    { regole, aggiornateIl: ora, aggiornateDa: 1 },
    { upsert: true },
  );
}

/** Inserisce una versione con numero progressivo; su collisione riprova col massimo. */
async function inserisciVersione(
  r: Regola,
  impronta: string,
  tipoModifica: string,
  origine: Origine,
  nota: string,
  ora: Date,
): Promise<void> {
  const contatori = await coll<{ _id: string; valore: number }>("contatori");
  const versioni = await coll("regole_versioni");

  for (let tentativo = 0; tentativo < 3; tentativo++) {
    const numero =
      ((
        await versioni
          .aggregate([
            { $match: { regolaId: r.id } },
            { $group: { _id: null, n: { $max: "$numero" } } },
          ])
          .next()
      )?.n ?? 0) + 1;

    const id = (
      await contatori.findOneAndUpdate(
        { _id: "regole_versioni" },
        { $inc: { valore: 1 } },
        { upsert: true, returnDocument: "after" },
      )
    )?.valore as number;

    const doc: Document = {
      _id: id,
      regolaId: r.id,
      numero,
      nome: r.nome,
      attiva: r.attiva,
      condizione: r.condizione,
      azioni: r.azioni,
      impronta,
      tipoModifica,
      origine,
      nota,
      creataIl: ora,
      creataDa: 1,
    };
    doc.sigillo = sigilla(doc);

    try {
      await versioni.insertOne(doc, { writeConcern: SCRITTURA_CRITICA });
      return;
    } catch (e) {
      // 11000 sull'indice {regolaId, numero}: un'altra scrittura ha preso lo
      // stesso numero. Si rilegge il massimo e si riprova.
      if ((e as { code?: number }).code === 11000 && tentativo < 2) continue;
      throw e;
    }
  }
}

// ------------------------------------------------------------------ storico

export type VersioneRegola = {
  id: number;
  regolaId: string;
  numero: number;
  nome: string;
  attiva: boolean;
  tipoModifica: string;
  origine: string;
  nota: string;
  creataIl: string;
  chi: string;
  esecuzioni: number;
  regola: Regola;
};

type DocVersione = {
  _id: number;
  regolaId: string;
  numero: number;
  nome: string;
  attiva: boolean;
  condizione: Regola["condizione"];
  azioni: Azione[];
  tipoModifica: string;
  origine: string;
  nota: string;
  creataIl: Date;
  creataDa: number;
};

async function componi(d: DocVersione): Promise<VersioneRegola> {
  const [chi, esecuzioni] = await Promise.all([nomeOperatore(d.creataDa), contaEsecuzioni(d._id)]);
  return {
    id: d._id,
    regolaId: d.regolaId,
    numero: d.numero,
    nome: d.nome,
    attiva: d.attiva,
    tipoModifica: d.tipoModifica,
    origine: d.origine,
    nota: d.nota,
    creataIl: d.creataIl.toISOString(),
    chi,
    esecuzioni,
    regola: { id: d.regolaId, nome: d.nome, attiva: d.attiva, condizione: d.condizione, azioni: d.azioni },
  };
}

async function nomeOperatore(id: number): Promise<string> {
  const o = await (await coll<{ _id: number; nome: string }>("operatori")).findOne({
    _id: id as unknown as Document["_id"],
  });
  return o?.nome ?? "Sistema";
}

async function contaEsecuzioni(versioneId: number): Promise<number> {
  return (await coll("esecuzioni")).countDocuments({ regolaVersioneId: versioneId });
}

export async function storicoRegola(regolaId: string): Promise<VersioneRegola[]> {
  const righe = await (await coll<DocVersione>("regole_versioni"))
    .find({ regolaId })
    .sort({ numero: -1 })
    .toArray();
  return Promise.all(righe.map(componi));
}

export async function ultimeVersioni(limite = 40): Promise<VersioneRegola[]> {
  const righe = await (await coll<DocVersione>("regole_versioni"))
    .find({})
    .sort({ creataIl: -1, _id: -1 })
    .limit(limite)
    .toArray();
  return Promise.all(righe.map(componi));
}

export async function versione(id: number): Promise<VersioneRegola | null> {
  const d = await (await coll<DocVersione>("regole_versioni")).findOne({
    _id: id as unknown as Document["_id"],
  });
  return d ? componi(d) : null;
}

export async function versioneCorrente(regolaId: string): Promise<number | null> {
  const d = await (await coll<DocVersione>("regole_versioni"))
    .find({ regolaId })
    .sort({ numero: -1 })
    .limit(1)
    .next();
  return d?._id ?? null;
}

// -------------------------------------------------------------------- diff

export type DifferenzaNodo = {
  azioneId: string;
  tipo: string;
  parametro: string;
  cambiamento: "aggiunto" | "rimosso" | "modificato" | "spostato";
  prima: string;
  dopo: string;
};

/** Confronto leggibile fra due versioni, appaiando i nodi per codice azione. RESTA SINCRONA. */
export function confronta(da: Regola, a: Regola): DifferenzaNodo[] {
  const out: DifferenzaNodo[] = [];
  const indiceDa = new Map(da.azioni.map((x, i) => [x.id, { azione: x, posizione: i }]));
  const indiceA = new Map(a.azioni.map((x, i) => [x.id, { azione: x, posizione: i }]));

  for (const [id, { azione, posizione }] of indiceA) {
    const vecchio = indiceDa.get(id);
    if (!vecchio) {
      out.push({ azioneId: id, tipo: azione.tipo, parametro: "", cambiamento: "aggiunto", prima: "", dopo: azione.tipo });
      continue;
    }
    const nomi = new Set([
      ...Object.keys(vecchio.azione.parametri ?? {}),
      ...Object.keys(azione.parametri ?? {}),
    ]);
    for (const nome of [...nomi].sort()) {
      const prima = vecchio.azione.parametri?.[nome] ?? "";
      const dopo = azione.parametri?.[nome] ?? "";
      if (prima !== dopo) {
        out.push({ azioneId: id, tipo: azione.tipo, parametro: nome, cambiamento: "modificato", prima, dopo });
      }
    }
    if (vecchio.posizione !== posizione) {
      out.push({
        azioneId: id,
        tipo: azione.tipo,
        parametro: "",
        cambiamento: "spostato",
        prima: `posizione ${vecchio.posizione + 1}`,
        dopo: `posizione ${posizione + 1}`,
      });
    }
  }

  for (const [id, { azione }] of indiceDa) {
    if (!indiceA.has(id)) {
      out.push({ azioneId: id, tipo: azione.tipo, parametro: "", cambiamento: "rimosso", prima: azione.tipo, dopo: "" });
    }
  }

  return out;
}
