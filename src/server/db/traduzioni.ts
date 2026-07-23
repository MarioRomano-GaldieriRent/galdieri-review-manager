import type { AnyBulkWriteOperation } from "mongodb";
import { coll, type DocGen } from "./connessione";

// Cache delle traduzioni Azure. La chiave (_id) è sha1(testo.trim()) tagliato a
// 20 caratteri, IDENTICA a quella del vecchio archivio: cambiarla vorrebbe dire
// ripagare Azure per tradurre di nuovo tutto lo storico. Il validator sulla
// forma dell'_id è la protezione più concreta di tutte.
//
// Nessuna funzione qui solleva: la traduzione è un'ottimizzazione, un database
// occupato non deve svuotare dashboard, recensioni e automazioni insieme.

export type VoceTradotta = {
  chiave: string;
  testoOriginale: string;
  italiano: string;
  linguaRilevata: string;
};

type DocTrad = {
  _id: string;
  testoOriginale: string;
  italiano: string;
  linguaRilevata: string | null;
};

export async function cercaTraduzioni(chiavi: string[]): Promise<Map<string, VoceTradotta>> {
  const out = new Map<string, VoceTradotta>();
  if (chiavi.length === 0) return out;
  try {
    const righe = await (await coll<DocTrad>("traduzioni"))
      .find({ _id: { $in: chiavi } })
      .toArray();
    for (const r of righe) {
      out.set(r._id, {
        chiave: r._id,
        testoOriginale: r.testoOriginale,
        italiano: r.italiano,
        linguaRilevata: r.linguaRilevata ?? "",
      });
    }
  } catch (e) {
    console.error("[traduzioni] lettura non riuscita:", e);
  }
  return out;
}

export async function salvaTraduzioni(voci: VoceTradotta[]): Promise<void> {
  if (voci.length === 0) return;
  const ora = new Date();
  try {
    // Le lingue rilevate devono esistere nella collezione lingue (il $lookup
    // della vista), con il codice come nome finché qualcuno non lo traduce.
    const codici = new Set(voci.map((v) => v.linguaRilevata).filter(Boolean));
    if (codici.size > 0) {
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

    await (await coll("traduzioni")).bulkWrite(
      voci.map((v) => ({
        updateOne: {
          filter: { _id: v.chiave },
          // pipeline: $inc e $setOnInsert non si combinano sullo stesso campo
          update: [
            {
              $set: {
                testoOriginale: v.testoOriginale,
                italiano: v.italiano,
                linguaRilevata: v.linguaRilevata || null,
                usataIl: ora,
                creataIl: { $ifNull: ["$creataIl", ora] },
                usi: { $add: [{ $ifNull: ["$usi", 0] }, 1] },
              },
            },
          ],
          upsert: true,
        },
      })) as AnyBulkWriteOperation<DocGen>[],
      { ordered: false },
    );
  } catch (e) {
    console.error("[traduzioni] scrittura non riuscita:", e);
  }
}

export async function segnaUso(chiavi: string[]): Promise<void> {
  if (chiavi.length === 0) return;
  try {
    await (await coll("traduzioni")).updateMany(
      { _id: { $in: chiavi } },
      [{ $set: { usi: { $add: [{ $ifNull: ["$usi", 0] }, 1] }, usataIl: new Date() } }],
    );
  } catch {
    // Statistica d'uso: se non si scrive, non è successo niente di grave.
  }
}
