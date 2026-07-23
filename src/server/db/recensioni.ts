import { createHash } from "node:crypto";
import type { AnyBulkWriteOperation, Document } from "mongodb";
import { coll, type DocGen } from "./connessione";
import { normalizzaSede } from "./seed";
import { tagSede } from "@/server/automation/sedi";
import type { Recensione } from "@/server/reviews/load";
import { FUSO } from "@/server/tempo";

// Archivio delle recensioni. È la memoria che a Graph manca: Graph mostra le
// ultime 50 email e basta, qui resta tutto quello che è passato di lì.
//
// La stessa recensione viene riletta decine di volte, e ogni rilettura può
// essere più povera (traduzione spenta, testo assente). Tre regole di prudenza:
//   1. i flag non tornano indietro          -> $max
//   2. un testo pieno non viene svuotato     -> coalesce(nullif(nuovo,''), vecchio)
//   3. prima_vista_il non si tocca mai       -> $ifNull su sé stesso
//
// L'upsert è una pipeline e non gli operatori $set/$setOnInsert/$max: con la
// logica qui sotto gli insiemi di campi non sono disgiunti, e $set + $setOnInsert
// sullo stesso campo dà "code 40: conflict". $setOnInsert non esiste come stage
// di pipeline (code 40324): il sostituto è $ifNull su sé stessi.
//
// Niente qui solleva: l'archiviazione non deve poter far fallire il caricamento
// delle pagine.

export function improntaRecensione(r: Recensione): string {
  const t = (r.italiano ?? r.originale ?? "").trim().toLowerCase();
  return createHash("sha1")
    .update(`${r.nome}|${r.stelle ?? ""}|${t}|${r.sede}`)
    .digest("hex")
    .slice(0, 20);
}

/** coalesce(nullif(nuovo,''), vecchio): un valore mancante non svuota quello che c'era. */
function vinceSePieno(nuovo: string, campoVecchio: string): Document {
  return { $cond: [{ $ne: [nuovo, ""] }, nuovo, { $ifNull: [campoVecchio, ""] }] };
}

export type ContatoriLettura = { letti: number; interpretati: number; scartati: number };

export async function salvaRecensioni(
  recensioni: Recensione[],
  etichettaId: string,
  contatori: ContatoriLettura,
): Promise<void> {
  const ora = new Date();

  try {
    // Prima le sedi e le lingue nuove, per il $lookup della vista e di perSede.
    await allineaSedi(recensioni);
    await allineaLingue(recensioni);

    const rec = await coll("recensioni");
    const ops: AnyBulkWriteOperation<DocGen>[] = recensioni
      .filter((r) => r.chiave)
      .map((r) => {
        const ricevutaIl = new Date(r.ricevutaIl);
        const sede = documentoSede(r.sede ?? "");
        const stelle = typeof r.stelle === "number" ? r.stelle : null;
        const lingua = (r.lingua || "").trim() || null;

        return {
          updateOne: {
            filter: { _id: r.chiave },
            update: [
              {
                $set: {
                  // vincono sempre
                  origine: "google",
                  messaggioId: r.messaggioId ?? "",
                  oggetto: r.oggetto ?? "",
                  etichettaId: etichettaId || null,
                  nomeCliente: r.nome || "(senza nome)",
                  giaItaliano: Boolean(r.giaItaliano),
                  ultimaVistaIl: ora,
                  impronta: improntaRecensione(r),
                  motivoArchiviazione: { $ifNull: ["$motivoArchiviazione", ""] },
                  testoTroncato: { $ifNull: ["$testoTroncato", false] },

                  // coalesce(nuovo, vecchio): mancante non cancella
                  stelle: { $ifNull: [stelle, { $ifNull: ["$stelle", null] }] },
                  lingua: { $ifNull: [lingua, { $ifNull: ["$lingua", null] }] },

                  // coalesce(nullif(nuovo,''), vecchio): traduzione mancante non svuota
                  testoOriginale: vinceSePieno(r.originale ?? "", "$testoOriginale"),
                  testoItaliano: vinceSePieno(r.italiano ?? "", "$testoItaliano"),
                  ingleseDiGoogle: vinceSePieno(r.ingleseDiGoogle ?? "", "$ingleseDiGoogle"),
                  punteggioTesto: vinceSePieno(r.punteggioTesto ?? "", "$punteggioTesto"),

                  // sede "" è la sentinella "non riconosciuta": non deve vincere
                  sede: {
                    $cond: [{ $ne: [sede.chiave, ""] }, sede, { $ifNull: ["$sede", sede] }],
                  },

                  // flag monotoni, booleani
                  haRisposta: { $max: [{ $ifNull: ["$haRisposta", false] }, Boolean(r.haRisposta)] },
                  risolto: { $max: [{ $ifNull: ["$risolto", false] }, Boolean(r.risolto)] },
                  numeroMessaggi: { $max: [{ $ifNull: ["$numeroMessaggi", 0] }, r.numeroMessaggi ?? 1] },

                  // data più antica: $ifNull PRIMA di $min, altrimenti un null la vince
                  ricevutaIl: { $min: [{ $ifNull: ["$ricevutaIl", ricevutaIl] }, ricevutaIl] },

                  // ex $setOnInsert: non si toccano mai più
                  primaVistaIl: { $ifNull: ["$primaVistaIl", ora] },
                  rispostaRilevataIl: {
                    $ifNull: ["$rispostaRilevataIl", r.haRisposta ? ora : null],
                  },
                  risoltoRilevatoIl: { $ifNull: ["$risoltoRilevatoIl", r.risolto ? ora : null] },
                  archiviataIl: { $ifNull: ["$archiviataIl", null] },
                },
              },
              {
                // SECONDO stage: i campi sopra hanno già il valore nuovo.
                $set: {
                  archiviata: { $ne: [{ $ifNull: ["$archiviataIl", null] }, null] },
                  ricevutaIlLocale: {
                    $dateToString: { date: "$ricevutaIl", format: "%Y-%m-%dT%H:%M:%S", timezone: FUSO },
                  },
                  settimanaIso: {
                    $dateToString: { date: "$ricevutaIl", format: "%G-W%V", timezone: FUSO },
                  },
                  // $dayOfWeek dà 1=domenica, il resto del codice usa 0=domenica
                  giornoSettimana: {
                    $subtract: [{ $dayOfWeek: { date: "$ricevutaIl", timezone: FUSO } }, 1],
                  },
                  haTesto: {
                    $gt: [
                      {
                        $strLenCP: {
                          $trim: {
                            input: {
                              $let: {
                                vars: { it: { $ifNull: ["$testoItaliano", ""] } },
                                in: {
                                  $cond: [
                                    { $eq: ["$$it", ""] },
                                    { $ifNull: ["$testoOriginale", ""] },
                                    "$$it",
                                  ],
                                },
                              },
                            },
                          },
                        },
                      },
                      0,
                    ],
                  },
                },
              },
              {
                // TERZO stage: annoMese/dataLocale/oraLocale derivano dalla stringa locale
                $set: {
                  annoMese: { $substrBytes: ["$ricevutaIlLocale", 0, 7] },
                  dataLocale: { $substrBytes: ["$ricevutaIlLocale", 0, 10] },
                  oraLocale: { $toInt: { $substrBytes: ["$ricevutaIlLocale", 11, 2] } },
                },
              },
            ],
            upsert: true,
          },
        } as AnyBulkWriteOperation<DocGen>;
      });

    let nuove = 0;
    let aggiornate = 0;
    let rifiutate = 0;
    if (ops.length > 0) {
      try {
        const res = await rec.bulkWrite(ops, { ordered: false });
        nuove = res.upsertedCount;
        aggiornate = res.modifiedCount;
      } catch (e) {
        // ordered:false continua oltre i documenti rifiutati dal validator: si
        // conta quanti, invece di perdere l'intero lotto.
        const err = e as { writeErrors?: unknown[]; result?: { nUpserted?: number; nModified?: number } };
        rifiutate = err.writeErrors?.length ?? 0;
        nuove = err.result?.nUpserted ?? 0;
        aggiornate = err.result?.nModified ?? 0;
        if (rifiutate === 0) throw e;
        console.error(`[recensioni] ${rifiutate} recensioni respinte dal validator`);
      }
    }

    // Una sola riga di sincronizzazione, alla fine: o dice il vero, o non esiste.
    await (await coll("sincronizzazioni")).insertOne({
      iniziataIl: ora,
      terminataIl: new Date(),
      etichettaId: etichettaId || null,
      messaggiLetti: contatori.letti,
      messaggiInterpretati: contatori.interpretati,
      messaggiScartati: contatori.scartati,
      recensioniViste: recensioni.length,
      recensioniNuove: nuove,
      recensioniAggiornate: aggiornate,
      recensioniRifiutate: rifiutate,
      esito: "ok",
      errore: null,
    } as Document);
  } catch (e) {
    console.error("[recensioni] archiviazione non riuscita:", e);
  }
}

function documentoSede(nome: string): { chiave: string; nome: string; tagFreshdesk: string } {
  const chiave = normalizzaSede(nome);
  if (!chiave) return { chiave: "", nome: "(sede non riconosciuta)", tagFreshdesk: "" };
  return { chiave, nome: nome.trim(), tagFreshdesk: tagSede(nome) };
}

async function allineaSedi(recensioni: Recensione[]): Promise<void> {
  const viste = new Map<string, { chiave: string; nome: string; tagFreshdesk: string }>();
  for (const r of recensioni) {
    const s = documentoSede(r.sede ?? "");
    if (s.chiave && !viste.has(s.chiave)) viste.set(s.chiave, s);
  }
  if (viste.size === 0) return;
  await (await coll("sedi")).bulkWrite(
    [...viste.values()].map((s) => ({
      updateOne: {
        filter: { _id: s.chiave },
        update: { $set: { nome: s.nome, tagFreshdesk: s.tagFreshdesk }, $setOnInsert: { creataIl: new Date() } },
        upsert: true,
      },
    })) as AnyBulkWriteOperation<DocGen>[],
    { ordered: false },
  );
}

async function allineaLingue(recensioni: Recensione[]): Promise<void> {
  const codici = new Set(recensioni.map((r) => (r.lingua || "").trim()).filter(Boolean));
  if (codici.size === 0) return;
  await (await coll("lingue")).bulkWrite(
    [...codici].map((c) => ({
      updateOne: {
        filter: { _id: c },
        update: { $setOnInsert: { nome: c, italiana: c === "it" } },
        upsert: true,
      },
    })) as AnyBulkWriteOperation<DocGen>[],
    { ordered: false },
  );
}

// ------------------------------------------------------------------ lettura

export type RecensioneArchiviata = Recensione & {
  primaVistaIl: string;
  archiviataIl: string | null;
  testoTroncato: boolean;
};

type DocRec = {
  _id: string;
  nomeCliente: string;
  stelle: number | null;
  punteggioTesto: string;
  testoOriginale: string;
  testoItaliano: string | null;
  giaItaliano: boolean;
  lingua: string | null;
  ingleseDiGoogle: string;
  sede: { chiave: string; nome: string; tagFreshdesk: string };
  oggetto: string;
  messaggioId: string;
  numeroMessaggi: number;
  haRisposta: boolean;
  risolto: boolean;
  ricevutaIl: Date;
  primaVistaIl: Date;
  archiviataIl: Date | null;
  testoTroncato: boolean;
};

function componi(d: DocRec): RecensioneArchiviata {
  return {
    chiave: d._id,
    nome: d.nomeCliente,
    stelle: d.stelle,
    punteggioTesto: d.punteggioTesto,
    originale: d.testoOriginale,
    italiano: d.testoItaliano,
    giaItaliano: d.giaItaliano,
    lingua: d.lingua ?? "",
    ingleseDiGoogle: d.ingleseDiGoogle,
    sede: d.sede.nome && d.sede.nome !== "(sede non riconosciuta)" ? d.sede.nome : "",
    oggetto: d.oggetto,
    ricevutaIl: d.ricevutaIl.toISOString(),
    messaggioId: d.messaggioId,
    numeroMessaggi: d.numeroMessaggi,
    haRisposta: d.haRisposta,
    risolto: d.risolto,
    primaVistaIl: d.primaVistaIl.toISOString(),
    archiviataIl: d.archiviataIl ? d.archiviataIl.toISOString() : null,
    testoTroncato: d.testoTroncato,
  };
}

export async function leggiRecensione(chiave: string): Promise<RecensioneArchiviata | null> {
  const d = await (await coll<DocRec>("recensioni")).findOne({ _id: chiave });
  return d ? componi(d) : null;
}

export async function leggiArchivio(limite = 200): Promise<RecensioneArchiviata[]> {
  const righe = await (await coll<DocRec>("recensioni"))
    .find({ archiviata: false })
    .sort({ ricevutaIl: -1 })
    .limit(limite)
    .toArray();
  return righe.map(componi);
}

export async function archiviaRecensione(chiave: string, motivo: string): Promise<void> {
  await (await coll("recensioni")).updateOne(
    { _id: chiave, archiviataIl: null },
    [
      { $set: { archiviataIl: new Date(), motivoArchiviazione: motivo } },
      { $set: { archiviata: true } },
    ],
  );
}
