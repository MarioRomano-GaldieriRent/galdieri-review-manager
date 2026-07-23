import type { Document } from "mongodb";
import { coll } from "./connessione";
import type { Esecuzione, EsitoNodo, StatoNodo, TipoAzione } from "@/server/automation/types";
import { CATALOGO } from "@/server/automation/types";

// Il registro delle esecuzioni. Un'esecuzione con i suoi nodi e scostamenti è
// UN SOLO DOCUMENTO: si scrive atomicamente, quindi l'assenza delle transazioni
// (mongod standalone) non è un problema. Niente si cancella: "rimetti in coda"
// e "svuota" marcano (annullata / archiviata), perché in modalità reale
// un'esecuzione può aver pubblicato davvero una risposta.

const LIMITE_CORPO = 8192; // il corpo della chiamata è l'unico campo che può gonfiare il documento

type DocNodo = {
  azioneCodice: string;
  tipo: string;
  stato: string;
  messaggio: string;
  scrittura: boolean;
  chiamata: { metodo: string; url: string; corpo: string | null } | null;
  durataMs: number;
};

type DocEsecuzione = {
  _id: string;
  quando: Date;
  modo: string;
  esito: string;
  regolaId: string;
  regolaNome: string;
  recensioneChiave: string;
  recensioneNome: string;
  recensioneStelle: number | null;
  recensioneSede: string;
  recensioneTesto: string;
  testoModificato: boolean;
  nodi: DocNodo[];
  annullata: boolean;
  archiviata: boolean;
};

function componi(d: DocEsecuzione): Esecuzione {
  const nodi: EsitoNodo[] = (d.nodi ?? []).map((n) => {
    const meta = CATALOGO[n.tipo as TipoAzione];
    return {
      azioneId: n.azioneCodice,
      tipo: n.tipo as TipoAzione,
      servizio: meta?.servizio ?? "sistema",
      titolo: meta?.titolo ?? n.tipo,
      stato: n.stato as StatoNodo,
      messaggio: n.messaggio,
      chiamata: n.chiamata
        ? { metodo: n.chiamata.metodo, url: n.chiamata.url, corpo: n.chiamata.corpo ?? undefined }
        : null,
      durataMs: n.durataMs,
    };
  });

  return {
    id: d._id,
    quando: d.quando.toISOString(),
    modo: d.modo === "reale" ? "reale" : "simulazione",
    regolaId: d.regolaId,
    regolaNome: d.regolaNome,
    recensione: {
      chiave: d.recensioneChiave,
      nome: d.recensioneNome,
      stelle: d.recensioneStelle,
      sede: d.recensioneSede,
      testo: d.recensioneTesto,
    },
    nodi,
    esito: d.esito === "errore" ? "errore" : "ok",
    testoModificato: d.testoModificato,
  };
}

export async function leggiEsecuzioni(limite = 200): Promise<Esecuzione[]> {
  const righe = await (await coll<DocEsecuzione>("esecuzioni"))
    .find({ annullata: false, archiviata: false })
    .sort({ quando: -1, _id: -1 })
    .limit(limite)
    .toArray();
  return righe.map(componi);
}

export async function ultimePerChiave(): Promise<Map<string, Esecuzione>> {
  const righe = await (await coll<DocEsecuzione>("esecuzioni"))
    .aggregate<DocEsecuzione>([
      { $match: { annullata: false, archiviata: false } },
      { $sort: { recensioneChiave: 1, quando: -1, _id: -1 } },
      { $group: { _id: "$recensioneChiave", ultima: { $first: "$$ROOT" } } },
      { $replaceWith: "$ultima" },
    ])
    .toArray();
  return new Map(righe.map((d) => [d.recensioneChiave, componi(d)]));
}

export type Scostamento = {
  azioneCodice: string;
  parametro: string;
  valoreVersione: string;
  valoreUsato: string;
};

export async function inserisciEsecuzione(
  e: Esecuzione,
  opzioni: {
    regolaVersioneId?: number | null;
    recensioneId?: number | null; // accettato e ignorato: i chiamanti non cambiano
    operatoreId?: number;
    scostamenti?: Scostamento[];
  } = {},
): Promise<void> {
  const nodi: DocNodo[] = e.nodi.map((n) => {
    const meta = CATALOGO[n.tipo as TipoAzione];
    return {
      azioneCodice: n.azioneId,
      tipo: n.tipo,
      stato: n.stato,
      messaggio: n.messaggio ?? "",
      scrittura: Boolean(meta?.scrittura),
      chiamata: n.chiamata
        ? {
            metodo: n.chiamata.metodo ?? "",
            url: n.chiamata.url,
            corpo: n.chiamata.corpo ? n.chiamata.corpo.slice(0, LIMITE_CORPO) : null,
          }
        : null,
      durataMs: n.durataMs ?? 0,
    };
  });

  const doc: Document = {
    _id: e.id,
    quando: new Date(e.quando),
    modo: e.modo,
    esito: e.esito,
    regolaId: e.regolaId,
    regolaNome: e.regolaNome,
    regolaVersioneId: opzioni.regolaVersioneId ?? null,
    operatoreId: opzioni.operatoreId ?? 1,
    recensioneChiave: e.recensione.chiave,
    recensioneNome: e.recensione.nome ?? "",
    recensioneStelle: e.recensione.stelle ?? null,
    recensioneSede: e.recensione.sede ?? "",
    recensioneTesto: e.recensione.testo ?? "",
    testoModificato: Boolean(e.testoModificato),
    durataMs: nodi.reduce((s, n) => s + (n.durataMs || 0), 0),
    nodi,
    scostamenti: opzioni.scostamenti ?? [],
    annullata: false,
    annullataIl: null,
    archiviata: false,
    archiviataIl: null,
  };

  await (await coll("esecuzioni")).insertOne(doc);
}

export async function annullaEsecuzione(id: string): Promise<void> {
  await (await coll("esecuzioni")).updateOne(
    { _id: id as unknown as Document["_id"], annullata: false },
    { $set: { annullata: true, annullataIl: new Date() } },
  );
}

export async function archiviaTutte(): Promise<void> {
  await (await coll("esecuzioni")).updateMany(
    { annullata: false, archiviata: false },
    { $set: { archiviata: true, archiviataIl: new Date() } },
  );
}

/**
 * Prima agganciava le esecuzioni orfane a un id surrogato di recensione. Ora
 * recensioneChiave È l'_id della recensione: non c'è più niente da agganciare.
 * Resta esportata perché i chiamanti la invocano.
 */
export async function agganciaRecensioni(): Promise<void> {
  /* no-op: la chiave di conversazione è già il collegamento */
}
