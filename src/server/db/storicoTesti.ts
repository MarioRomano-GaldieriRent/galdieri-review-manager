import { createHash } from "node:crypto";
import { SCRITTURA_CRITICA, coll } from "./connessione";

// ---------------------------------------------------------------------------
// STORICO DEI TESTI: tutte le versioni, per sempre.
//
// Prima di questo modulo ogni testo viveva in un campo solo e ogni passaggio lo
// sovrascriveva: la recensione riletta cancellava la versione precedente, la
// ri-approvazione riscriveva la risposta, e della riscrittura a mano restava il
// solo booleano `testoModificato`. Il lavoro c'era, la sua storia no.
//
// Serve a una cosa precisa: tarare l'AI sulle risposte vere. Il materiale utile
// non è la risposta pubblicata — quella la dà già `memoria_esempi` — ma la
// COPPIA proposta/pubblicata, cioè la correzione che una persona ha fatto al
// modello. È il segnale che dice dove sbaglia, e finora lo buttavamo via.
//
// Due regole, e da queste discende tutto il resto:
//
//   1. SOLA AGGIUNTA. Nessuna funzione qui dentro aggiorna o cancella. Un testo
//      registrato è un fatto avvenuto: riscriverlo sarebbe riscrivere la storia.
//
//   2. DEDUP PER IMPRONTA. L'indice unico (recensioneChiave, tipo, impronta)
//      rende ogni aggancio idempotente. La stessa recensione viene riletta
//      decine di volte al giorno: senza dedup lo storico sarebbe fatto al 99%
//      di copie identiche. Con la dedup, chi aggancia può essere CIECO — chiama
//      e basta, senza prima chiedersi «è cambiato qualcosa?».
//
// Niente qui solleva mai. Lo storico è un testimone: se cade lui non deve
// cadere la sincronizzazione, né una risposta che sta partendo davvero.
// ---------------------------------------------------------------------------

export type TipoTesto =
  /** Il testo del cliente, nella sua lingua. */
  | "recensione"
  /** L'italiano che ne abbiamo ricavato (Azure, o già italiano). */
  | "traduzione"
  /** Il testo che la regola metteva nel riquadro: il «prima» di una riscrittura. */
  | "proposta-regola"
  /** Il suggerimento del modello: l'altro «prima», quello che conta per l'AI. */
  | "proposta-ai"
  /** Il testo approvato: quello che va, o è andato, online. */
  | "inviata";

export type OrigineTesto =
  "sincronizzazione" | "regola" | "ai" | "operatore" | "pilota" | "customer-care";

export type RifTesto = {
  esecuzioneId?: string;
  regolaId?: string;
  regolaVersioneId?: number | null;
  modello?: string;
  esempiUsati?: number | null;
  recuperatoDa?: string;
};

export type VersioneTesto = {
  recensioneChiave: string;
  tipo: TipoTesto;
  testo: string;
  lingua?: string | null;
  origine: OrigineTesto;
  operatoreId?: number;
  modo?: "reale" | "simulazione";
  /** Il testo è un ritaglio, non l'intero: lo mette solo il recupero del passato. */
  troncato?: boolean;
  /** Quando è ACCADUTO, non quando lo scriviamo: il recupero del passato lo valorizza. */
  quando?: Date;
  rif?: RifTesto;
};

/** Come `improntaRecensione`: sha1 del testo normalizzato, per riconoscere le copie. */
export function improntaTesto(t: string): string {
  return createHash("sha1").update(t.trim()).digest("hex");
}

function documento(v: VersioneTesto) {
  const testo = v.testo.trim();
  return {
    recensioneChiave: v.recensioneChiave,
    tipo: v.tipo,
    testo,
    lingua: v.lingua ?? null,
    impronta: improntaTesto(testo),
    origine: v.origine,
    operatoreId: v.operatoreId ?? 1,
    troncato: v.troncato || undefined,
    modo: v.modo,
    quando: v.quando ?? new Date(),
    rif: v.rif ?? null,
  };
}

/**
 * La forma di MongoBulkWriteError che ci serve. `insertedCount` sta SULL'ERRORE
 * (driver 7): il vecchio `result.nInserted` non esiste più, e leggerlo dava
 * sempre zero — cioè «non ho scritto niente» proprio nel giro in cui invece
 * aveva scritto.
 */
type ErroreScrittura = {
  code?: number;
  insertedCount?: number;
  writeErrors?: { code?: number; err?: { code?: number } }[];
};

/**
 * Registra delle versioni. Le copie di testi già conservati e i testi vuoti si
 * scartano da sole: chi chiama non deve controllare niente.
 *
 * `ordered: false` è la chiave della scrittura in blocco: un duplicato (11000)
 * fa fallire la sua riga e basta, le altre entrano comunque. Con `ordered: true`
 * il primo testo già visto fermerebbe tutto il resto del lotto — che in una
 * sincronizzazione è il caso NORMALE, non l'eccezione.
 *
 * Ritorna quante versioni sono davvero entrate.
 */
export async function registraVersioni(voci: VersioneTesto[]): Promise<number> {
  const documenti = voci.filter((v) => v.recensioneChiave && v.testo.trim()).map(documento);
  if (documenti.length === 0) return 0;

  try {
    const r = await (
      await coll("storico_testi")
    ).insertMany(documenti, { ordered: false, writeConcern: SCRITTURA_CRITICA });
    return r.insertedCount;
  } catch (e) {
    // Il duplicato non è un errore: è la dedup che funziona. Si riferisce solo
    // quello che duplicato non era.
    const err = e as ErroreScrittura;
    const codici = (err.writeErrors ?? []).map((w) => w.code ?? w.err?.code);
    const soloDuplicati = codici.length > 0 && codici.every((c) => c === 11000);
    if (!soloDuplicati && err.code !== 11000) {
      console.error("[storico] registrazione non riuscita:", e);
    }
    return err.insertedCount ?? 0;
  }
}

/** Una sola versione. Comodità: quasi tutti gli agganci ne hanno una. */
export async function registraVersione(v: VersioneTesto): Promise<void> {
  await registraVersioni([v]);
}

export type VoceStorico = {
  recensioneChiave: string;
  tipo: TipoTesto;
  testo: string;
  lingua: string | null;
  origine: OrigineTesto;
  operatoreId: number;
  troncato: boolean;
  modo: "reale" | "simulazione" | null;
  quando: string;
  rif: RifTesto | null;
};

type DocStorico = {
  recensioneChiave: string;
  tipo: TipoTesto;
  testo: string;
  lingua: string | null;
  impronta: string;
  origine: OrigineTesto;
  operatoreId: number;
  troncato?: boolean;
  modo?: "reale" | "simulazione";
  quando: Date;
  rif: RifTesto | null;
};

function componi(d: DocStorico): VoceStorico {
  return {
    recensioneChiave: d.recensioneChiave,
    tipo: d.tipo,
    testo: d.testo,
    lingua: d.lingua,
    origine: d.origine,
    operatoreId: d.operatoreId,
    troncato: Boolean(d.troncato),
    modo: d.modo ?? null,
    quando: d.quando.toISOString(),
    rif: d.rif,
  };
}

/** Tutta la storia di una recensione, dalla più vecchia: come si è arrivati lì. */
export async function versioniDi(chiave: string): Promise<VoceStorico[]> {
  try {
    const righe = await (
      await coll<DocStorico>("storico_testi")
    )
      .find({ recensioneChiave: chiave })
      .sort({ quando: 1, _id: 1 })
      .toArray();
    return righe.map(componi);
  } catch (e) {
    console.error("[storico] lettura non riuscita:", e);
    return [];
  }
}

export type Correzione = {
  recensioneChiave: string;
  recensione: string;
  proposta: string;
  propostaDa: "ai" | "regola";
  inviata: string;
  lingua: string | null;
  modello: string;
  quando: string;
};

type RigaCorrezione = {
  _id: string;
  recensioni: string[];
  proposte: { testo: string; origine: OrigineTesto; modello: string; quando: Date }[];
  inviate: { testo: string; lingua: string | null; quando: Date }[];
};

/**
 * Le COPPIE proposta/pubblicata: il materiale per tarare l'AI.
 *
 * Una recensione entra solo se ha sia una proposta sia un testo inviato, e solo
 * se i due DIFFERISCONO: dove la persona ha accettato la proposta così com'era
 * non c'è niente da imparare, il modello aveva già ragione. Fra le proposte
 * vince quella dell'AI sulla regola, perché è il modello che vogliamo correggere.
 *
 * Solo modalità reale: una prova in simulazione non è una risposta data a
 * qualcuno e non deve insegnare niente.
 */
export async function correzioni(limite = 1000): Promise<Correzione[]> {
  try {
    const righe = await (
      await coll<DocStorico>("storico_testi")
    )
      .aggregate<RigaCorrezione>(
        [
          // Niente simulazioni (non è una risposta data a qualcuno) e niente
          // ritagli del recupero: un testo mozzato insegnerebbe a scrivere mozzo.
          {
            $match: {
              troncato: { $ne: true },
              $or: [{ modo: "reale" }, { modo: { $exists: false } }],
            },
          },
          { $sort: { quando: 1 } },
          {
            $group: {
              _id: "$recensioneChiave",
              // Un array, non un $last: `$last` guarda l'ULTIMO documento del
              // gruppo, che quasi sempre è la risposta e non la recensione — e
              // allora il testo del cliente risulterebbe assente proprio dove c'è.
              recensioni: {
                $push: { $cond: [{ $eq: ["$tipo", "recensione"] }, "$testo", "$$REMOVE"] },
              },
              proposte: {
                $push: {
                  $cond: [
                    { $in: ["$tipo", ["proposta-ai", "proposta-regola"]] },
                    {
                      testo: "$testo",
                      origine: "$origine",
                      modello: { $ifNull: ["$rif.modello", ""] },
                      quando: "$quando",
                    },
                    "$$REMOVE",
                  ],
                },
              },
              inviate: {
                $push: {
                  $cond: [
                    { $eq: ["$tipo", "inviata"] },
                    { testo: "$testo", lingua: "$lingua", quando: "$quando" },
                    "$$REMOVE",
                  ],
                },
              },
            },
          },
          { $match: { "proposte.0": { $exists: true }, "inviate.0": { $exists: true } } },
          { $sort: { _id: 1 } },
          { $limit: limite },
        ],
        // L'ordinamento prima del raggruppamento non ha un indice che lo copra e
        // lo storico cresce per sempre: senza, un giorno supererebbe i 100 MB di
        // memoria e l'estrazione morirebbe proprio quando i dati sono tanti
        // abbastanza da servire.
        { allowDiskUse: true },
      )
      .toArray();

    const fuori: Correzione[] = [];
    for (const r of righe) {
      const daAi = [...r.proposte].reverse().find((p) => p.origine === "ai");
      const proposta = daAi ?? r.proposte.at(-1);
      const inviata = r.inviate.at(-1);
      if (!proposta || !inviata) continue;
      if (improntaTesto(proposta.testo) === improntaTesto(inviata.testo)) continue;
      fuori.push({
        recensioneChiave: r._id,
        recensione: r.recensioni.at(-1) ?? "",
        proposta: proposta.testo,
        propostaDa: proposta.origine === "ai" ? "ai" : "regola",
        inviata: inviata.testo,
        lingua: inviata.lingua,
        modello: proposta.modello,
        quando: inviata.quando.toISOString(),
      });
    }
    return fuori;
  } catch (e) {
    console.error("[storico] estrazione correzioni non riuscita:", e);
    return [];
  }
}

/** Quante versioni per tipo: la riga di riepilogo della verifica. */
export async function contaStorico(): Promise<Record<string, number>> {
  try {
    const righe = await (
      await coll("storico_testi")
    )
      .aggregate<{ _id: string; n: number }>([{ $group: { _id: "$tipo", n: { $sum: 1 } } }])
      .toArray();
    return Object.fromEntries(righe.map((r) => [r._id, r.n]));
  } catch {
    return {};
  }
}
