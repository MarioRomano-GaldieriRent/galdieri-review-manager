import type { Document } from "mongodb";
import { coll } from "@/server/db/connessione";

// Le statistiche, in aggregation pipeline. Le regole di forma non cambiano dal
// tempo di SQLite: si legge SOLO dall'archivio (mai la finestra live), e ogni
// funzione porta la sua BASE. Cambiano solo le trappole, che qui sono altre:
//
//  - {stelle: {$lte: 2}} nel query language conta SOLO stelle:2 (type
//    bracketing, come SQL). {$expr:{$lte:["$stelle",2]}} conterebbe anche null
//    e assenti: si usa $isNumber dentro gli $expr.
//  - "pubblicate" vuole $elemMatch (un nodo che sia ok E google.rispondi
//    insieme), non due condizioni separate sull'array.
//  - $divide per zero è errore duro, non null: sempre dentro un $cond su base>0.
//  - $facet al livello alto restituisce sempre un documento, anche su
//    collezione vuota: da lì il $ifNull ovunque, per non mostrare NaN.

const NEG = { $and: [{ $isNumber: "$stelle" }, { $lte: ["$stelle", 2] }] };

async function aggr<T extends Document = Document>(nome: string, pipeline: Document[]): Promise<T[]> {
  return (await coll(nome)).aggregate<T>(pipeline).toArray();
}
async function conta(nome: string, filtro: Document = {}): Promise<number> {
  return (await coll(nome)).countDocuments(filtro);
}

// ------------------------------------------------------------------ copertura

export type Copertura = {
  primaRaccolta: string | null;
  ultimaRaccolta: string | null;
  giorniCoperti: number;
  recensioni: number;
  archiviate: number;
  ricostruite: number;
  sincronizzazioni: number;
  messaggiLetti: number;
  messaggiScartati: number;
  senzaPunteggio: number;
  senzaSede: number;
  possibiliDoppioni: number;
  giorniSenzaRaccolta: number;
};

export async function copertura(): Promise<Copertura> {
  const estremiRec = await aggr<{ prima: Date | null; ultima: Date | null }>("recensioni", [
    { $group: { _id: null, prima: { $min: "$primaVistaIl" }, ultima: { $max: "$ultimaVistaIl" } } },
  ]);
  const prima = estremiRec[0]?.prima ?? null;
  const ultima = estremiRec[0]?.ultima ?? null;
  const giorni =
    prima && ultima
      ? Math.max(1, Math.round((ultima.getTime() - prima.getTime()) / 86400000) + 1)
      : 0;

  const sinc = await aggr<{ giorni: string[] }>("sincronizzazioni", [
    {
      $group: {
        _id: null,
        giorni: {
          $addToSet: { $dateToString: { date: "$iniziataIl", format: "%Y-%m-%d", timezone: "UTC" } },
        },
      },
    },
  ]);
  const giorniConRaccolta = sinc[0]?.giorni.length ?? 0;

  // L'ultima passata, non la somma. Ordine su iniziataIl (l'_id ObjectId ordina
  // solo al secondo, e dopo un riavvio due sync nello stesso secondo si
  // invertirebbero); _id solo come spareggio.
  const ultimaPassata = await aggr<{ letti: number; scartati: number }>("sincronizzazioni", [
    { $sort: { iniziataIl: -1, _id: -1 } },
    { $limit: 1 },
    { $project: { _id: 0, letti: "$messaggiLetti", scartati: "$messaggiScartati" } },
  ]);

  const doppioni = await aggr<{ n: number }>("recensioni", [
    { $match: { impronta: { $type: "string" } } },
    { $group: { _id: "$impronta", c: { $sum: 1 } } },
    { $match: { c: { $gt: 1 } } },
    { $count: "n" },
  ]);

  return {
    primaRaccolta: prima ? prima.toISOString() : null,
    ultimaRaccolta: ultima ? ultima.toISOString() : null,
    giorniCoperti: giorni,
    recensioni: await conta("recensioni"),
    archiviate: await conta("recensioni", { archiviata: true }),
    ricostruite: await conta("recensioni", { testoTroncato: true }),
    sincronizzazioni: await conta("sincronizzazioni"),
    messaggiLetti: ultimaPassata[0]?.letti ?? 0,
    messaggiScartati: ultimaPassata[0]?.scartati ?? 0,
    senzaPunteggio: await conta("recensioni", { stelle: null }),
    senzaSede: await conta("recensioni", { "sede.chiave": "" }),
    possibiliDoppioni: doppioni[0]?.n ?? 0,
    giorniSenzaRaccolta: Math.max(0, giorni - giorniConRaccolta),
  };
}

// ------------------------------------------------------------------ volume

export type Settimana = { settimana: string; recensioni: number; negative: number };

export async function perSettimana(limite = 26): Promise<Settimana[]> {
  const righe = await aggr<Settimana>("recensioni", [
    { $match: { settimanaIso: { $gt: "" } } },
    {
      $group: {
        _id: "$settimanaIso",
        recensioni: { $sum: 1 },
        negative: { $sum: { $cond: [NEG, 1, 0] } },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: limite },
    { $project: { _id: 0, settimana: "$_id", recensioni: 1, negative: 1 } },
  ]);
  return righe.reverse();
}

// --------------------------------------------------------------- punteggio

export type Punteggi = {
  distribuzione: { stelle: number; quante: number }[];
  senzaPunteggio: number;
  base: number;
  media: number | null;
  cinqueSenzaCommento: number;
  cinqueConCommento: number;
  negative: number;
};

export async function punteggi(): Promise<Punteggi> {
  const distribuzione = await aggr<{ stelle: number; quante: number }>("recensioni", [
    { $match: { stelle: { $ne: null } } },
    { $group: { _id: "$stelle", quante: { $sum: 1 } } },
    { $sort: { _id: -1 } },
    { $project: { _id: 0, stelle: "$_id", quante: 1 } },
  ]);
  const base = distribuzione.reduce((s, d) => s + d.quante, 0);
  const somma = distribuzione.reduce((s, d) => s + d.stelle * d.quante, 0);

  return {
    distribuzione,
    senzaPunteggio: await conta("recensioni", { stelle: null }),
    base,
    media: base > 0 ? somma / base : null,
    cinqueSenzaCommento: await conta("recensioni", { stelle: 5, haTesto: false }),
    cinqueConCommento: await conta("recensioni", { stelle: 5, haTesto: true }),
    // query language: type bracketing, conta solo stelle:2 e stelle:1
    negative: await conta("recensioni", { stelle: { $lte: 2 } }),
  };
}

// -------------------------------------------------------------------- sedi

export type RigaSede = {
  sede: string;
  recensioni: number;
  negative: number;
  media: number | null;
  baseSufficiente: boolean;
};

export const SOGLIA_SEDE = 20;

export async function perSede(): Promise<RigaSede[]> {
  const righe = await aggr<{
    chiave: string;
    nomeDenorm: string;
    recensioni: number;
    negative: number;
    somma: number;
    conPunteggio: number;
  }>("recensioni", [
    {
      $group: {
        _id: "$sede.chiave",
        nomeDenorm: { $first: "$sede.nome" },
        recensioni: { $sum: 1 },
        negative: { $sum: { $cond: [NEG, 1, 0] } },
        somma: { $sum: { $cond: [{ $isNumber: "$stelle" }, "$stelle", 0] } },
        conPunteggio: { $sum: { $cond: [{ $isNumber: "$stelle" }, 1, 0] } },
      },
    },
    { $lookup: { from: "sedi", localField: "_id", foreignField: "_id", as: "_s" } },
    {
      $project: {
        _id: 0,
        chiave: "$_id",
        // il nome corrente della sede vince sul denormalizzato
        nomeDenorm: { $ifNull: [{ $first: "$_s.nome" }, "$nomeDenorm"] },
        recensioni: 1,
        negative: 1,
        somma: 1,
        conPunteggio: 1,
      },
    },
    { $sort: { recensioni: -1, nomeDenorm: 1 } },
  ]);

  return righe.map((r) => ({
    sede: r.nomeDenorm,
    recensioni: r.recensioni,
    negative: r.negative,
    media: r.conPunteggio > 0 ? r.somma / r.conPunteggio : null,
    baseSufficiente: r.recensioni >= SOGLIA_SEDE,
  }));
}

// ------------------------------------------------------------------ lingue

export type Lingue = {
  righe: { lingua: string; quante: number }[];
  conCommento: number;
  soloPunteggio: number;
  lunghezzaMediana: number | null;
};

export async function lingue(): Promise<Lingue> {
  // $group prima del $lookup: la join serve solo alla decorazione, e costa una
  // ricerca per lingua distinta invece che per documento.
  const righe = await aggr<{ lingua: string; quante: number }>("recensioni", [
    { $match: { haTesto: true } },
    { $group: { _id: "$lingua", quante: { $sum: 1 } } },
    { $lookup: { from: "lingue", localField: "_id", foreignField: "_id", as: "_l" } },
    { $project: { _id: 0, lingua: { $ifNull: [{ $first: "$_l.nome" }, "non rilevata"] }, quante: 1 } },
    { $sort: { quante: -1, lingua: 1 } },
  ]);

  // Mediana della lunghezza. coalesce(nullif(italiano,''), originale): con
  // $ifNull nudo la traduzione fallita ("") entrerebbe con lunghezza 0.
  const mediana = await aggr<{ v: number | null }>("recensioni", [
    { $match: { haTesto: true } },
    {
      $set: {
        _t: {
          $let: {
            vars: { it: { $ifNull: ["$testoItaliano", ""] } },
            in: { $cond: [{ $eq: ["$$it", ""] }, { $ifNull: ["$testoOriginale", ""] }, "$$it"] },
          },
        },
      },
    },
    { $set: { _len: { $strLenCP: { $trim: { input: "$_t" } } } } },
    { $group: { _id: null, lunghezze: { $push: "$_len" } } },
    { $set: { ordinate: { $sortArray: { input: "$lunghezze", sortBy: 1 } } } },
    {
      $project: {
        _id: 0,
        v: {
          $cond: [
            { $gt: [{ $size: "$ordinate" }, 0] },
            { $arrayElemAt: ["$ordinate", { $floor: { $divide: [{ $size: "$ordinate" }, 2] } }] },
            null,
          ],
        },
      },
    },
  ]);

  return {
    righe,
    conCommento: await conta("recensioni", { haTesto: true }),
    soloPunteggio: await conta("recensioni", { haTesto: false }),
    lunghezzaMediana: mediana[0]?.v ?? null,
  };
}

// ------------------------------------------------------------- lavorazione

export type Lavorazione = {
  flussiSimulati: number;
  flussiReali: number;
  pubblicateDavvero: number;
  scrittureRiuscite: number;
  conErrore: number;
  riscritture: number;
  copertePerRegola: { regola: string; quante: number }[];
  ticketTrovati: number;
  ticketNonTrovati: number;
  erroriPerNodo: { titolo: string; quanti: number }[];
};

export async function lavorazione(): Promise<Lavorazione> {
  // Un solo $match sulle non annullate, poi $facet: il filtro "annullata:false"
  // sta una volta sola, l'omissione è strutturalmente impossibile.
  const f = await aggr<Document>("esecuzioni", [
    { $match: { annullata: false } },
    {
      $facet: {
        simulati: [{ $match: { modo: "simulazione" } }, { $count: "n" }],
        reali: [{ $match: { modo: "reale" } }, { $count: "n" }],
        errore: [{ $match: { esito: "errore" } }, { $count: "n" }],
        riscritture: [{ $match: { testoModificato: true } }, { $count: "n" }],
        // $elemMatch: un nodo che sia ok E google.rispondi insieme, non due
        // condizioni separate che si accontenterebbero di nodi diversi.
        pubblicate: [
          { $match: { modo: "reale", nodi: { $elemMatch: { stato: "ok", tipo: "google.rispondi" } } } },
          { $count: "n" },
        ],
        scritture: [
          { $match: { modo: "reale", nodi: { $elemMatch: { stato: "ok", scrittura: true } } } },
          { $count: "n" },
        ],
        perRegola: [
          { $group: { _id: "$regolaNome", n: { $sum: 1 } } },
          { $sort: { n: -1, _id: 1 } },
        ],
        ticketTrovati: [
          {
            $set: {
              _t: {
                $size: {
                  $filter: {
                    input: "$nodi",
                    as: "n",
                    cond: {
                      $and: [
                        { $eq: ["$$n.tipo", "freshdesk.trovaTicket"] },
                        { $regexMatch: { input: "$$n.messaggio", regex: "^Ticket #" } },
                      ],
                    },
                  },
                },
              },
            },
          },
          { $group: { _id: null, n: { $sum: "$_t" } } },
        ],
        ticketNonTrovati: [
          {
            $set: {
              _t: {
                $size: {
                  $filter: {
                    input: "$nodi",
                    as: "n",
                    cond: {
                      $and: [
                        { $eq: ["$$n.tipo", "freshdesk.trovaTicket"] },
                        { $regexMatch: { input: "$$n.messaggio", regex: "^Nessun ticket" } },
                      ],
                    },
                  },
                },
              },
            },
          },
          { $group: { _id: null, n: { $sum: "$_t" } } },
        ],
        // errori per nodo: si conta il nodo, non l'esecuzione
        erroriNodi: [
          { $unwind: "$nodi" },
          { $match: { "nodi.stato": "errore" } },
          { $group: { _id: "$nodi.tipo", n: { $sum: 1 } } },
          { $sort: { n: -1, _id: 1 } },
        ],
      },
    },
  ]);

  const d = f[0] ?? {};
  const primo = (arr: Document[] | undefined): number => (arr && arr[0] ? (arr[0].n as number) : 0);

  // titoli dei nodi in errore, dal catalogo
  const tipi = new Map<string, string>(
    (await (await coll("tipi_azione")).find({}).toArray()).map((t) => [
      t._id as string,
      t.titolo as string,
    ]),
  );

  return {
    flussiSimulati: primo(d.simulati as Document[]),
    flussiReali: primo(d.reali as Document[]),
    pubblicateDavvero: primo(d.pubblicate as Document[]),
    scrittureRiuscite: primo(d.scritture as Document[]),
    conErrore: primo(d.errore as Document[]),
    riscritture: primo(d.riscritture as Document[]),
    copertePerRegola: ((d.perRegola as Document[]) ?? []).map((x) => ({
      regola: x._id as string,
      quante: x.n as number,
    })),
    ticketTrovati: primo(d.ticketTrovati as Document[]),
    ticketNonTrovati: primo(d.ticketNonTrovati as Document[]),
    erroriPerNodo: ((d.erroriNodi as Document[]) ?? []).map((x) => ({
      titolo: tipi.get(x._id as string) ?? (x._id as string),
      quanti: x.n as number,
    })),
  };
}

/**
 * Recensioni in coda coperte da una regola attiva. Le combinazioni possibili
 * sono al massimo 5 stelle × 2 valori di haTesto = 10: si materializzano in
 * TypeScript e si fanno due conteggi, invece di un $lookup che su standalone
 * leggerebbe le regole senza uno snapshot condiviso con le recensioni.
 */
export async function coperturaRegole(): Promise<{ coperte: number; scoperte: number }> {
  const doc = await (await coll("regole")).findOne({ _id: "correnti" as unknown as Document["_id"] });
  const regole = (doc?.regole ?? []) as {
    attiva: boolean;
    condizione: { stelle: number[]; testo: "con" | "senza" | "qualsiasi" };
  }[];

  // combinazioni (stelle, haTesto) coperte da almeno una regola attiva
  const conTesto = new Set<number>();
  const senzaTesto = new Set<number>();
  for (const r of regole) {
    if (!r.attiva) continue;
    for (const s of r.condizione.stelle) {
      if (r.condizione.testo !== "senza") conTesto.add(s);
      if (r.condizione.testo !== "con") senzaTesto.add(s);
    }
  }

  const clausole: Document[] = [];
  for (const s of conTesto) clausole.push({ stelle: s, haTesto: true });
  for (const s of senzaTesto) clausole.push({ stelle: s, haTesto: false });

  const totale = await conta("recensioni", { archiviata: false });
  // Le recensioni con stelle null restano scoperte, come in SQL: nessuna regola
  // può decidere cosa farne.
  const coperte =
    clausole.length === 0
      ? 0
      : await conta("recensioni", { archiviata: false, $or: clausole });

  return { coperte, scoperte: totale - coperte };
}
