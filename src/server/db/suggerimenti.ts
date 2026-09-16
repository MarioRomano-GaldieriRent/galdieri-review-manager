import { coll } from "./connessione";
import { registraVersione } from "./storicoTesti";

// Risposte suggerite dall'AI, conservate per recensione: si generano una volta
// sola e al ricarico della home sono già pronte (pagina immediata, nessuna
// spesa ripetuta). Restano proposte: pubblica sempre una persona.

export type Suggerito = {
  chiave: string;
  testo: string;
  lingua: "it" | "en";
  modello: string;
  esempiUsati: number;
  generatoIl: string;
};

type DocSug = {
  _id: string;
  testo: string;
  lingua: "it" | "en";
  modello: string;
  esempiUsati: number;
  costo?: number | null;
  generatoIl: Date;
};

async function sugg() {
  return coll<DocSug>("ai_suggerimenti");
}

function componi(d: DocSug): Suggerito {
  return {
    chiave: d._id,
    testo: d.testo,
    lingua: d.lingua,
    modello: d.modello,
    esempiUsati: d.esempiUsati,
    generatoIl: d.generatoIl.toISOString(),
  };
}

export async function leggiSuggerimento(chiave: string): Promise<Suggerito | null> {
  const d = await (await sugg()).findOne({ _id: chiave });
  return d ? componi(d) : null;
}

/** I suggerimenti già pronti per le recensioni in elenco, in una sola query. */
export async function suggerimentiPer(chiavi: string[]): Promise<Map<string, Suggerito>> {
  if (chiavi.length === 0) return new Map();
  const righe = await (await sugg()).find({ _id: { $in: chiavi } }).toArray();
  return new Map(righe.map((d) => [d._id, componi(d)]));
}

export async function salvaSuggerimento(
  chiave: string,
  dati: {
    testo: string;
    lingua: "it" | "en";
    modello: string;
    esempiUsati: number;
    costo?: number;
  },
): Promise<void> {
  await (
    await sugg()
  ).updateOne(
    { _id: chiave },
    {
      $set: {
        testo: dati.testo,
        lingua: dati.lingua,
        modello: dati.modello,
        esempiUsati: dati.esempiUsati,
        costo: dati.costo ?? null,
        generatoIl: new Date(),
      },
    },
    { upsert: true },
  );

  // Il documento qui sopra tiene UNA proposta per recensione e la rigenerazione
  // la sovrascrive. Lo storico le tiene tutte: è il «prima» da confrontare con
  // quello che la persona pubblicherà davvero, cioè il dato su cui l'AI andrà
  // tarata. Che modello l'ha scritta e con quanti esempi fa parte del fatto.
  await registraVersione({
    recensioneChiave: chiave,
    tipo: "proposta-ai",
    testo: dati.testo,
    lingua: dati.lingua,
    origine: "ai",
    rif: { modello: dati.modello, esempiUsati: dati.esempiUsati },
  });
}

/** Cancella la proposta salvata: al prossimo giro se ne genera una nuova. */
export async function scartaSuggerimento(chiave: string): Promise<void> {
  await (await sugg()).deleteOne({ _id: chiave });
}
