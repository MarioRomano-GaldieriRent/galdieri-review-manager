import type { Db } from "mongodb";
import { coll, db } from "./connessione";
import { applicaSchema } from "./schema";
import { semina } from "./seed";
import { travasaTutto } from "./travaso";

// Avvio del database: schema, semina e travaso dai vecchi file JSON.
//
// Gira una volta sola, chiamato da src/instrumentation.ts quando Next parte.
// A differenza della versione SQLite (sincrona, dentro db()), qui è tutto
// asincrono: due richieste concorrenti al primo avvio entrerebbero entrambe,
// quindi la semina e il travaso girano dentro un lucchetto.

let fatto: Promise<void> | null = null;

export async function avvia(): Promise<void> {
  if (fatto) return fatto;
  fatto = eseguiAvvio().catch((e) => {
    // Se l'avvio fallisce si azzera, così il tentativo successivo riprova
    // invece di restituire per sempre la stessa Promise rifiutata.
    fatto = null;
    console.error("[db] avvio non completato:", e);
    throw e;
  });
  return fatto;
}

async function eseguiAvvio(): Promise<void> {
  const d = await db();
  await applicaSchema(d);
  await semina(d);
  await conLucchetto("avvio:travaso", travasaTutto);
}

/**
 * Mutua esclusione tramite un documento con _id fisso: l'insertOne È il
 * lucchetto, perché _id è unico. Solo una esecuzione lo crea; le altre prendono
 * 11000 e si fermano. Se l'azione fallisce, il lucchetto si toglie, altrimenti
 * il travaso non si ritenterebbe mai più e nessuno se ne accorgerebbe finché
 * non mancano i dati.
 */
async function conLucchetto(nome: string, azione: (d: Db) => Promise<void>): Promise<void> {
  const l = await coll<{ _id: string; preso: Date; completato?: Date }>("lucchetti");
  try {
    await l.insertOne({ _id: nome, preso: new Date() });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return; // un altro lo sta facendo o l'ha fatto
    throw e;
  }
  try {
    await azione(await db());
    await l.updateOne({ _id: nome }, { $set: { completato: new Date() } });
  } catch (errore) {
    await l.deleteOne({ _id: nome }).catch(() => {});
    throw errore;
  }
}
