import { coll } from "./connessione";
import type { Recensione } from "@/server/reviews/load";

// «In attesa»: recensioni negative INOLTRATE al customer care, in attesa che
// Cherubina rimandi il testo della risposta. Quando la risposta viene recuperata
// dalla posta la voce diventa «pronta» e ricompare in «Da approvare» col testo
// precompilato; dopo la pubblicazione su Google diventa «chiusa».
//
//   attesa  → inoltrata, nessuna risposta ancora (tab «In attesa»)
//   pronta  → risposta recuperata, precompilata (torna in «Da approvare»)
//   chiusa  → risposta pubblicata su Google (fuori da entrambe)

export type StatoEscalation = "attesa" | "pronta" | "chiusa";

export type Escalation = {
  chiave: string;
  sedeNome: string;
  nomeCliente: string;
  stelle: number | null;
  oggetto: string;
  ricevutaIl: string;
  messaggioId: string;
  originale: string;
  idGoogle: string;
  ticketId: number | null;
  inoltrataIl: string;
  operatoreId: number;
  stato: StatoEscalation;
  rispostaTesto: string | null;
  rispostaTicket: number | null;
  rispostaTrovataIl: string | null;
  aggiornataIl: string;
};

type DocEsc = {
  _id: string;
  sedeNome: string;
  nomeCliente: string;
  stelle: number | null;
  oggetto: string;
  ricevutaIl: Date;
  messaggioId: string;
  originale: string;
  idGoogle: string;
  ticketId: number | null;
  inoltrataIl: Date;
  operatoreId: number;
  stato: StatoEscalation;
  rispostaTesto: string | null;
  rispostaTicket: number | null;
  rispostaTrovataIl: Date | null;
  aggiornataIl: Date;
};

async function escalations() {
  return coll<DocEsc>("escalation");
}

function componi(d: DocEsc): Escalation {
  return {
    chiave: d._id,
    sedeNome: d.sedeNome,
    nomeCliente: d.nomeCliente,
    stelle: d.stelle,
    oggetto: d.oggetto,
    ricevutaIl: d.ricevutaIl.toISOString(),
    messaggioId: d.messaggioId,
    originale: d.originale,
    idGoogle: d.idGoogle,
    ticketId: d.ticketId,
    inoltrataIl: d.inoltrataIl.toISOString(),
    operatoreId: d.operatoreId,
    stato: d.stato,
    rispostaTesto: d.rispostaTesto,
    rispostaTicket: d.rispostaTicket,
    rispostaTrovataIl: d.rispostaTrovataIl ? d.rispostaTrovataIl.toISOString() : null,
    aggiornataIl: d.aggiornataIl.toISOString(),
  };
}

/** Registra (o aggiorna) l'inoltro di una recensione negativa: stato «attesa». */
export async function registraInoltro(
  r: Recensione,
  opts: { ticketId: number | null; operatoreId: number },
): Promise<void> {
  const ora = new Date();
  await (await escalations()).updateOne(
    { _id: r.chiave },
    {
      $set: {
        sedeNome: r.sede,
        nomeCliente: r.nome,
        stelle: r.stelle,
        oggetto: r.oggetto,
        ricevutaIl: new Date(r.ricevutaIl),
        messaggioId: r.messaggioId,
        originale: r.originale,
        idGoogle: r.idGoogle,
        ticketId: opts.ticketId,
        inoltrataIl: ora,
        operatoreId: opts.operatoreId,
        aggiornataIl: ora,
      },
      // Solo alla PRIMA registrazione: non si azzera una risposta già trovata.
      $setOnInsert: {
        stato: "attesa",
        rispostaTesto: null,
        rispostaTicket: null,
        rispostaTrovataIl: null,
      },
    },
    { upsert: true },
  );
}

export async function leggiEscalation(chiave: string): Promise<Escalation | null> {
  const d = await (await escalations()).findOne({ _id: chiave });
  return d ? componi(d) : null;
}

/** In attesa della risposta (tab «In attesa»), dalla più recente. */
export async function elencoInAttesa(): Promise<Escalation[]> {
  const righe = await (await escalations())
    .find({ stato: "attesa" })
    .sort({ inoltrataIl: -1 })
    .toArray();
  return righe.map(componi);
}

/** Risposte recuperate e non ancora pubblicate (precompilate in «Da approvare»). */
export async function elencoPronte(): Promise<Escalation[]> {
  const righe = await (await escalations())
    .find({ stato: "pronta" })
    .sort({ rispostaTrovataIl: -1 })
    .toArray();
  return righe.map(componi);
}

/** Chiavi ancora nel ciclo escalation (attesa o pronta): NON riproporle come «da inoltrare». */
export async function chiaviInCiclo(): Promise<Set<string>> {
  const righe = await (await escalations())
    .find({ stato: { $in: ["attesa", "pronta"] } }, { projection: { _id: 1 } })
    .toArray();
  return new Set(righe.map((d) => d._id));
}

/** Salva la risposta recuperata e porta la voce a «pronta». */
export async function salvaRisposta(
  chiave: string,
  testo: string,
  ticket: number | null,
  quando: string,
): Promise<void> {
  await (await escalations()).updateOne(
    { _id: chiave },
    {
      $set: {
        rispostaTesto: testo,
        rispostaTicket: ticket,
        rispostaTrovataIl: new Date(quando),
        stato: "pronta",
        aggiornataIl: new Date(),
      },
    },
  );
}

/** Dopo la pubblicazione su Google: fuori dal ciclo. */
export async function segnaChiusa(chiave: string): Promise<void> {
  await (await escalations()).updateOne(
    { _id: chiave },
    { $set: { stato: "chiusa", aggiornataIl: new Date() } },
  );
}

/** Rimuove del tutto una voce (uso operativo/diagnostico). */
export async function rimuoviEscalation(chiave: string): Promise<void> {
  await (await escalations()).deleteOne({ _id: chiave });
}
