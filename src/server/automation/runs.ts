import {
  annullaEsecuzione,
  archiviaTutte,
  inserisciEsecuzione,
  leggiEsecuzioni,
  ultimePerChiave,
  type Scostamento,
} from "@/server/db/esecuzioni";
import { versioneCorrente } from "@/server/db/regole";
import type { Esecuzione } from "./types";

// Registro delle esecuzioni, ora nel database.
//
// Due cose sono cambiate rispetto al file JSON, ed erano il motivo per cui
// serviva un database:
//
//   — il taglio a 100 non c'è più. Il registro è la base delle statistiche:
//     buttare via le righe vecchie significava buttare via le statistiche.
//   — non si cancella più niente. "Rimetti in coda" e "svuota registro"
//     marcano la riga invece di eliminarla: l'esecuzione è comunque avvenuta,
//     e in modalità reale può aver pubblicato davvero una risposta. Farla
//     sparire sarebbe riscrivere la storia.
//
// Le firme restano identiche a prima: nessun chiamante è stato toccato.

export async function caricaEsecuzioni(limite = 200): Promise<Esecuzione[]> {
  try {
    return await leggiEsecuzioni(limite);
  } catch (e) {
    console.error("[esecuzioni] lettura non riuscita:", e);
    return [];
  }
}

export async function registraEsecuzione(
  e: Esecuzione,
  scostamenti: Scostamento[] = [],
): Promise<void> {
  try {
    // Aggancio alla versione di regola in vigore adesso: è ciò che permette di
    // rileggere fra sei mesi con quale testo esatto è partito questo flusso.
    // L'inoltro manuale non è una regola persistita e resta senza versione.
    const versione = await versioneCorrente(e.regolaId);
    await inserisciEsecuzione(e, { regolaVersioneId: versione, scostamenti });
  } catch (errore) {
    // Il flusso è già stato eseguito: se la registrazione fallisce si perde la
    // traccia, non il lavoro. Sollevare qui mostrerebbe un errore all'utente
    // per qualcosa che invece è andato a buon fine.
    console.error("[esecuzioni] registrazione non riuscita:", errore);
  }
}

export async function svuotaEsecuzioni(): Promise<void> {
  await archiviaTutte();
}

/** Toglie una singola prova dal registro: la recensione torna in coda. */
export async function eliminaEsecuzione(id: string): Promise<void> {
  await annullaEsecuzione(id);
}

/** Ultima esecuzione per ciascuna recensione. */
export async function ultimePerRecensione(): Promise<Map<string, Esecuzione>> {
  try {
    return await ultimePerChiave();
  } catch (e) {
    console.error("[esecuzioni] lettura non riuscita:", e);
    return new Map();
  }
}
