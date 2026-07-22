import { esegui, tutteLeRighe, transazione } from "./connessione";
import { adesso } from "@/server/tempo";

// Cache delle traduzioni Azure.
//
// La chiave resta identica a quella del vecchio file: sha1(testo.trim()) tagliato
// a 20 caratteri. Cambiarla vorrebbe dire buttare via tutta la cache accumulata
// e ripagare Azure per tradurre di nuovo lo stesso storico.
//
// NESSUNA funzione di questo modulo solleva: la traduzione è un'ottimizzazione,
// e un database occupato non deve poter svuotare la dashboard, le recensioni e
// le automazioni tutte insieme.

export type VoceTradotta = {
  chiave: string;
  testoOriginale: string;
  italiano: string;
  linguaRilevata: string;
};

export function cercaTraduzioni(chiavi: string[]): Map<string, VoceTradotta> {
  const out = new Map<string, VoceTradotta>();
  if (chiavi.length === 0) return out;

  try {
    // Una query sola con IN: fare N SELECT sarebbe comunque veloce, ma questa
    // funzione gira su ogni caricamento di tre pagine.
    const segnaposto = chiavi.map(() => "?").join(",");
    const righe = tutteLeRighe<{
      chiave: string;
      testo_originale: string;
      italiano: string;
      lingua_rilevata: string | null;
    }>(
      `SELECT chiave, testo_originale, italiano, lingua_rilevata
         FROM traduzioni WHERE chiave IN (${segnaposto})`,
      ...chiavi,
    );
    for (const r of righe) {
      out.set(r.chiave, {
        chiave: r.chiave,
        testoOriginale: r.testo_originale,
        italiano: r.italiano,
        linguaRilevata: r.lingua_rilevata ?? "",
      });
    }
  } catch (e) {
    console.error("[traduzioni] lettura non riuscita:", e);
  }
  return out;
}

export function salvaTraduzioni(voci: VoceTradotta[]): void {
  if (voci.length === 0) return;
  const ora = adesso();
  try {
    transazione(() => {
      for (const v of voci) {
        // La lingua rilevata deve esistere in `lingue` per via della FK sulle
        // recensioni: la si aggiunge qui, con il codice come nome finché
        // qualcuno non lo traduce.
        if (v.linguaRilevata) {
          esegui(
            "INSERT INTO lingue (codice, nome, italiana) VALUES (?,?,?) ON CONFLICT(codice) DO NOTHING",
            v.linguaRilevata,
            v.linguaRilevata,
            v.linguaRilevata === "it" ? 1 : 0,
          );
        }
        esegui(
          `INSERT INTO traduzioni (chiave, testo_originale, italiano, lingua_rilevata, creata_il, usata_il, usi)
           VALUES (?,?,?,?,?,?,1)
           ON CONFLICT(chiave) DO UPDATE SET
             italiano = excluded.italiano,
             lingua_rilevata = excluded.lingua_rilevata,
             usata_il = excluded.usata_il,
             usi = usi + 1`,
          v.chiave,
          v.testoOriginale,
          v.italiano,
          v.linguaRilevata || null,
          ora,
          ora,
        );
      }
    });
  } catch (e) {
    console.error("[traduzioni] scrittura non riuscita:", e);
  }
}

/** Segna l'uso delle traduzioni pescate dalla cache, per sapere quali servono. */
export function segnaUso(chiavi: string[]): void {
  if (chiavi.length === 0) return;
  try {
    const segnaposto = chiavi.map(() => "?").join(",");
    esegui(
      `UPDATE traduzioni SET usi = usi + 1, usata_il = ? WHERE chiave IN (${segnaposto})`,
      adesso(),
      ...chiavi,
    );
  } catch {
    // Statistica d'uso: se non si scrive, non è successo niente di grave.
  }
}
