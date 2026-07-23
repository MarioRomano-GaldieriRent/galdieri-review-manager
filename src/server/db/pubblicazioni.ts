import type { Document } from "mongodb";
import { coll } from "./connessione";
import { OPERATORE_SISTEMA, registraAttivita } from "./attivita";

// Coda di pubblicazione manuale: il modello dati della feature "one-click".
//
// Un documento per recensione (chiave = recensioneChiave). Le transizioni sono
// funzioni esplicite, non $set sparsi: così ogni cambio di stato scrive anche
// l'audit e nessuno può saltarlo. Lo stato Freshdesk è a parte dallo stato
// della coda: la risposta può essere "pubblicata" anche se la chiusura del
// ticket è ancora "in attesa" di retry — l'operatore non si blocca per Freshdesk.

/** Ore di attesa prima del ricontrollo della risposta su Google. */
export const ORE_RICONTROLLO = 24;

export type StatoPubblicazione = "approvata" | "pubblicata" | "verificata";
export type EsitoFreshdesk = "noniniziato" | "ok" | "inattesa" | "fallito";

export type DatiApprovazione = {
  chiave: string;
  origine: "google" | "trustpilot";
  testoRisposta: string;
  lingua: string;
  nomeCliente: string;
  stelle: number | null;
  sedeChiave: string;
  sedeNome: string;
  testoRecensione: string;
  messaggioId: string;
  ticketId: number | null;
};

export type VocePubblicazione = {
  chiave: string;
  origine: "google" | "trustpilot";
  stato: StatoPubblicazione;
  testoRisposta: string;
  lingua: string;
  nomeCliente: string;
  stelle: number | null;
  sedeChiave: string;
  sedeNome: string;
  testoRecensione: string;
  messaggioId: string;
  ticketId: number | null;
  /** Presi dalla sede al momento della lettura: l'admin può cambiarli dopo. */
  googleReviewsUrl: string;
  placeId: string;
  freshdeskEsito: EsitoFreshdesk;
  freshdeskTentativi: number;
  freshdeskErrore: string;
  photoChecked: boolean;
  approvataIl: string;
  pubblicataIl: string | null;
  promemoriaVerificaIl: string | null;
  ripubblicazioni: number;
};

type DocPub = {
  _id: string;
  origine: "google" | "trustpilot";
  stato: StatoPubblicazione;
  testoRisposta: string;
  lingua: string | null;
  nomeCliente: string;
  stelle: number | null;
  sedeChiave: string;
  sedeNome: string;
  testoRecensione: string;
  messaggioId: string;
  ticketId: number | null;
  freshdeskEsito: EsitoFreshdesk;
  freshdeskTentativi: number;
  freshdeskErrore: string;
  photoChecked: boolean;
  approvataIl: Date;
  pubblicataIl: Date | null;
  promemoriaVerificaIl: Date | null;
  ripubblicazioni: number;
  googleReviewsUrl?: string;
  placeId?: string;
};

function componi(d: DocPub): VocePubblicazione {
  return {
    chiave: d._id,
    origine: d.origine,
    stato: d.stato,
    testoRisposta: d.testoRisposta,
    lingua: d.lingua ?? "",
    nomeCliente: d.nomeCliente,
    stelle: d.stelle,
    sedeChiave: d.sedeChiave,
    sedeNome: d.sedeNome,
    testoRecensione: d.testoRecensione,
    messaggioId: d.messaggioId,
    ticketId: d.ticketId,
    googleReviewsUrl: d.googleReviewsUrl ?? "",
    placeId: d.placeId ?? "",
    freshdeskEsito: d.freshdeskEsito,
    freshdeskTentativi: d.freshdeskTentativi,
    freshdeskErrore: d.freshdeskErrore,
    photoChecked: d.photoChecked,
    approvataIl: d.approvataIl.toISOString(),
    pubblicataIl: d.pubblicataIl ? d.pubblicataIl.toISOString() : null,
    promemoriaVerificaIl: d.promemoriaVerificaIl ? d.promemoriaVerificaIl.toISOString() : null,
    ripubblicazioni: d.ripubblicazioni,
  };
}

/**
 * Il link "Apri su Google", strategia a cascata (spec §4):
 *   1. l'URL di gestione recensioni della sede, se l'admin l'ha compilato;
 *   2. altrimenti, dal place_id, la pagina delle recensioni del posto;
 *   3. altrimenti il link generico, e la sede va cercata a mano.
 * Trustpilot usa direttamente la piattaforma.
 */
export function linkGoogle(v: { origine: string; googleReviewsUrl: string; placeId: string }): {
  url: string;
  generico: boolean;
} {
  if (v.origine === "trustpilot") {
    return { url: "https://business.trustpilot.com/reviews", generico: true };
  }
  if (v.googleReviewsUrl.trim()) return { url: v.googleReviewsUrl.trim(), generico: false };
  if (v.placeId.trim()) {
    return {
      url: `https://search.google.com/local/reviews?placeid=${encodeURIComponent(v.placeId.trim())}`,
      generico: false,
    };
  }
  return { url: "https://business.google.com/reviews", generico: true };
}

// -------------------------------------------------------------- scrittura

/**
 * Mette (o rimette) una recensione in coda con la risposta approvata.
 *
 * Upsert per chiave: se la voce non c'è nasce in stato "approvata"; se c'è già
 * si aggiorna il testo e si riporta ad "approvata" (una ri-approvazione dopo
 * che era stata pubblicata è un rifacimento voluto). Il contatore delle
 * ripubblicazioni e la data di creazione non si toccano.
 */
export async function approvaPerPubblicazione(
  d: DatiApprovazione,
  operatoreId = OPERATORE_SISTEMA,
): Promise<void> {
  const ora = new Date();
  await (
    await coll("pubblicazioni")
  ).updateOne(
    { _id: d.chiave },
    [
      {
        $set: {
          origine: d.origine,
          stato: "approvata",
          testoRisposta: d.testoRisposta,
          lingua: d.lingua || null,
          nomeCliente: d.nomeCliente || "(senza nome)",
          stelle: typeof d.stelle === "number" ? d.stelle : null,
          sedeChiave: d.sedeChiave,
          sedeNome: d.sedeNome,
          testoRecensione: d.testoRecensione,
          messaggioId: d.messaggioId,
          ticketId: typeof d.ticketId === "number" ? d.ticketId : null,
          approvataIl: ora,
          approvataDa: operatoreId,
          aggiornataIl: ora,
          // Un nuovo giro azzera l'esito della verifica precedente.
          pubblicataIl: null,
          pubblicataDa: null,
          metodoPubblicazione: "",
          promemoriaVerificaIl: null,
          verificataIl: null,
          verificataDa: null,
          esitoVerifica: "",
          // Ex $setOnInsert: si fissano solo alla nascita.
          photoChecked: { $ifNull: ["$photoChecked", false] },
          ripubblicazioni: { $ifNull: ["$ripubblicazioni", 0] },
          freshdeskEsito: { $ifNull: ["$freshdeskEsito", "noniniziato"] },
          freshdeskTentativi: { $ifNull: ["$freshdeskTentativi", 0] },
          freshdeskErrore: { $ifNull: ["$freshdeskErrore", ""] },
          freshdeskProssimoTentativoIl: { $ifNull: ["$freshdeskProssimoTentativoIl", null] },
          creataIl: { $ifNull: ["$creataIl", ora] },
        },
      },
    ] as Document[],
    { upsert: true },
  );

  await registraAttivita("pubblicazione.approvata", {
    operatoreId,
    oggettoTipo: "recensione",
    oggettoId: d.chiave,
    dettaglio: `Risposta pronta per la pubblicazione: «${d.testoRisposta.slice(0, 120)}»`,
  });
}

/** approvata → pubblicata: segnata come pubblicata su Google, parte l'attesa del ricontrollo. */
export async function segnaPubblicata(
  chiave: string,
  operatoreId = OPERATORE_SISTEMA,
  photoChecked = false,
): Promise<boolean> {
  const ora = new Date();
  const promemoria = new Date(ora.getTime() + ORE_RICONTROLLO * 3600 * 1000);
  const r = await (
    await coll("pubblicazioni")
  ).updateOne(
    { _id: chiave, stato: "approvata" },
    {
      $set: {
        stato: "pubblicata",
        pubblicataIl: ora,
        pubblicataDa: operatoreId,
        metodoPubblicazione: "manuale",
        promemoriaVerificaIl: promemoria,
        photoChecked,
        aggiornataIl: ora,
      },
    },
  );
  if (r.matchedCount === 0) return false;
  await registraAttivita("pubblicazione.pubblicata", {
    operatoreId,
    oggettoTipo: "recensione",
    oggettoId: chiave,
    dettaglio: `Segnata come pubblicata a mano. Ricontrollo previsto dopo ${ORE_RICONTROLLO}h.`,
  });
  return true;
}

/** pubblicata → approvata: annulla una pubblicazione segnata per errore. */
export async function annullaPubblicazione(
  chiave: string,
  operatoreId = OPERATORE_SISTEMA,
): Promise<boolean> {
  const ora = new Date();
  const r = await (
    await coll("pubblicazioni")
  ).updateOne(
    { _id: chiave, stato: "pubblicata" },
    {
      $set: {
        stato: "approvata",
        pubblicataIl: null,
        pubblicataDa: null,
        metodoPubblicazione: "",
        promemoriaVerificaIl: null,
        aggiornataIl: ora,
      },
    },
  );
  if (r.matchedCount === 0) return false;
  await registraAttivita("pubblicazione.annullata", {
    operatoreId,
    oggettoTipo: "recensione",
    oggettoId: chiave,
    dettaglio: "Pubblicazione annullata: la risposta torna fra quelle da pubblicare.",
  });
  return true;
}

/** pubblicata → verificata: la risposta risulta online, il caso è chiuso. */
export async function confermaOnline(
  chiave: string,
  operatoreId = OPERATORE_SISTEMA,
): Promise<boolean> {
  const ora = new Date();
  const r = await (
    await coll("pubblicazioni")
  ).updateOne(
    { _id: chiave, stato: "pubblicata" },
    {
      $set: {
        stato: "verificata",
        verificataIl: ora,
        verificataDa: operatoreId,
        esitoVerifica: "confermata",
        aggiornataIl: ora,
      },
    },
  );
  if (r.matchedCount === 0) return false;
  await registraAttivita("pubblicazione.verificata", {
    operatoreId,
    oggettoTipo: "recensione",
    oggettoId: chiave,
    dettaglio: "Risposta confermata online.",
  });
  return true;
}

/** pubblicata → approvata (di nuovo in cima) quando la risposta è sparita da Google. */
export async function segnalaSparita(
  chiave: string,
  operatoreId = OPERATORE_SISTEMA,
): Promise<boolean> {
  const ora = new Date();
  // Pipeline invece di {$set,$inc}: l'incremento si fa con $add su sé stesso,
  // così resta coerente con le altre transizioni e non serve tipare $inc.
  const r = await (
    await coll("pubblicazioni")
  ).updateOne({ _id: chiave, stato: "pubblicata" }, [
    {
      $set: {
        stato: "approvata",
        // approvataIl a ora: così torna in CIMA alla coda (ordinata dalla più
        // vecchia), non in fondo — va ripubblicata subito.
        approvataIl: ora,
        pubblicataIl: null,
        pubblicataDa: null,
        metodoPubblicazione: "",
        promemoriaVerificaIl: null,
        esitoVerifica: "sparita",
        aggiornataIl: ora,
        ripubblicazioni: { $add: [{ $ifNull: ["$ripubblicazioni", 0] }, 1] },
      },
    },
  ] as Document[]);
  if (r.matchedCount === 0) return false;
  await registraAttivita("pubblicazione.sparita", {
    operatoreId,
    oggettoTipo: "recensione",
    oggettoId: chiave,
    dettaglio: "Risposta sparita da Google: rimessa in coda per la ripubblicazione.",
  });
  return true;
}

// --------------------------------------------------- esito chiusura Freshdesk

/** Registra come è andata la chiusura del ticket. Non cambia lo stato della coda. */
export async function segnaEsitoFreshdesk(
  chiave: string,
  esito: EsitoFreshdesk,
  opts: { errore?: string; tentativi?: number; prossimoTentativoIl?: Date | null } = {},
): Promise<void> {
  const set: Document = {
    freshdeskEsito: esito,
    freshdeskErrore: opts.errore ?? "",
    aggiornataIl: new Date(),
  };
  if (typeof opts.tentativi === "number") set.freshdeskTentativi = opts.tentativi;
  set.freshdeskProssimoTentativoIl = opts.prossimoTentativoIl ?? null;
  await (await coll("pubblicazioni")).updateOne({ _id: chiave }, { $set: set });
}

// -------------------------------------------------------------- lettura

const LOOKUP_SEDE: Document[] = [
  { $lookup: { from: "sedi", localField: "sedeChiave", foreignField: "_id", as: "_s" } },
  { $unwind: { path: "$_s", preserveNullAndEmptyArrays: true } },
  {
    $set: {
      googleReviewsUrl: { $ifNull: ["$_s.googleReviewsUrl", ""] },
      placeId: { $ifNull: ["$_s.placeId", ""] },
      // Il nome corrente della sede vince sul denormalizzato.
      sedeNome: { $ifNull: ["$_s.nome", "$sedeNome"] },
    },
  },
  { $unset: "_s" },
];

async function leggiPerStato(
  stato: StatoPubblicazione,
  ordina: Document,
  filtri: { sede?: string; origine?: string; stelle?: number } = {},
): Promise<VocePubblicazione[]> {
  const match: Document = { stato };
  if (filtri.sede) match.sedeChiave = filtri.sede;
  if (filtri.origine) match.origine = filtri.origine;
  if (filtri.stelle) match.stelle = filtri.stelle;

  const righe = (await (
    await coll("pubblicazioni")
  )
    .aggregate([{ $match: match }, ...LOOKUP_SEDE, { $sort: ordina }])
    .toArray()) as DocPub[];
  return righe.map(componi);
}

/** La coda "da pubblicare": approvate, dalla più vecchia. */
export async function codaDaPubblicare(
  filtri: {
    sede?: string;
    origine?: string;
    stelle?: number;
  } = {},
): Promise<VocePubblicazione[]> {
  return leggiPerStato("approvata", { approvataIl: 1 }, filtri);
}

/** La tab "da ricontrollare": pubblicate, dal promemoria più prossimo. */
export async function codaDaRicontrollare(): Promise<VocePubblicazione[]> {
  return leggiPerStato("pubblicata", { promemoriaVerificaIl: 1 });
}

export async function leggiPubblicazione(chiave: string): Promise<VocePubblicazione | null> {
  const righe = (await (
    await coll("pubblicazioni")
  )
    .aggregate([{ $match: { _id: chiave } }, ...LOOKUP_SEDE, { $limit: 1 }])
    .toArray()) as DocPub[];
  return righe[0] ? componi(righe[0]) : null;
}

export type ConteggiPubblicazione = {
  daPubblicare: number;
  daRicontrollare: number;
  verificate: number;
};

export async function conteggiPubblicazione(): Promise<ConteggiPubblicazione> {
  const righe = (await (
    await coll("pubblicazioni")
  )
    .aggregate([{ $group: { _id: "$stato", n: { $sum: 1 } } }])
    .toArray()) as { _id: StatoPubblicazione; n: number }[];
  const per = new Map(righe.map((r) => [r._id, r.n]));
  return {
    daPubblicare: per.get("approvata") ?? 0,
    daRicontrollare: per.get("pubblicata") ?? 0,
    verificate: per.get("verificata") ?? 0,
  };
}
