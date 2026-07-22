import { esegui, tutteLeRighe, transazione } from "./connessione";
import type { Esecuzione, EsitoNodo, StatoNodo, TipoAzione } from "@/server/automation/types";
import { CATALOGO } from "@/server/automation/types";
import { adesso } from "@/server/tempo";

// Il registro delle esecuzioni.
//
// Due differenze rispetto al file JSON di prima, entrambe volute:
//   — non c'è più il taglio a 100. Se il registro è la base delle statistiche,
//     buttare via le righe vecchie significa buttare via le statistiche.
//   — niente cancellazioni. "Rimetti in coda" e "svuota registro" marcano la
//     riga (annullata_il, archiviata_il): l'esecuzione è comunque avvenuta, e
//     in modalità reale può aver pubblicato davvero una risposta. Far sparire
//     quel fatto sarebbe riscrivere la storia.

type RigaEsecuzione = {
  id: string;
  quando: string;
  modo: string;
  esito: string;
  regola_id: string;
  regola_nome: string;
  recensione_chiave: string;
  recensione_nome: string;
  recensione_stelle: number | null;
  recensione_sede: string;
  recensione_testo: string;
  testo_modificato: number;
  annullata_il: string | null;
  archiviata_il: string | null;
};

type RigaNodo = {
  esecuzione_id: string;
  azione_codice: string;
  tipo: string;
  stato: string;
  messaggio: string;
  chiamata_metodo: string | null;
  chiamata_url: string | null;
  chiamata_corpo: string | null;
  durata_ms: number;
};

function componi(righe: RigaEsecuzione[], nodi: RigaNodo[]): Esecuzione[] {
  const perEsecuzione = new Map<string, EsitoNodo[]>();
  for (const n of nodi) {
    const arr = perEsecuzione.get(n.esecuzione_id) ?? [];
    const meta = CATALOGO[n.tipo as TipoAzione];
    arr.push({
      azioneId: n.azione_codice,
      tipo: n.tipo as TipoAzione,
      servizio: meta?.servizio ?? "sistema",
      titolo: meta?.titolo ?? n.tipo,
      stato: n.stato as StatoNodo,
      messaggio: n.messaggio,
      chiamata: n.chiamata_url
        ? {
            metodo: n.chiamata_metodo ?? "",
            url: n.chiamata_url,
            corpo: n.chiamata_corpo ?? undefined,
          }
        : null,
      durataMs: n.durata_ms,
    });
    perEsecuzione.set(n.esecuzione_id, arr);
  }

  return righe.map((r) => ({
    id: r.id,
    quando: r.quando,
    modo: r.modo === "reale" ? "reale" : "simulazione",
    regolaId: r.regola_id,
    regolaNome: r.regola_nome,
    recensione: {
      chiave: r.recensione_chiave,
      nome: r.recensione_nome,
      stelle: r.recensione_stelle,
      sede: r.recensione_sede,
      testo: r.recensione_testo,
    },
    nodi: perEsecuzione.get(r.id) ?? [],
    esito: r.esito === "errore" ? "errore" : "ok",
    testoModificato: r.testo_modificato === 1,
  }));
}

const CAMPI = `id, quando, modo, esito, regola_id, regola_nome, recensione_chiave,
               recensione_nome, recensione_stelle, recensione_sede, recensione_testo,
               testo_modificato, annullata_il, archiviata_il`;

/**
 * Esecuzioni visibili nel registro, dalla più recente.
 *
 * ORDER BY esplicito: prima l'ordine veniva dall'unshift sull'array in
 * memoria. Un SELECT senza ordinamento restituirebbe la più vecchia per prima
 * e "l'ultima esecuzione" diventerebbe la prima — con l'effetto che una
 * recensione già lavorata tornerebbe in coda e potrebbe ricevere una seconda
 * risposta.
 */
export function leggiEsecuzioni(limite = 200): Esecuzione[] {
  const righe = tutteLeRighe<RigaEsecuzione>(
    `SELECT ${CAMPI} FROM esecuzioni
      WHERE annullata_il IS NULL AND archiviata_il IS NULL
      ORDER BY quando DESC, rowid DESC LIMIT ?`,
    limite,
  );
  if (righe.length === 0) return [];
  const id = righe.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(",");
  const nodi = tutteLeRighe<RigaNodo>(
    `SELECT esecuzione_id, azione_codice, tipo, stato, messaggio,
            chiamata_metodo, chiamata_url, chiamata_corpo, durata_ms
       FROM esiti_nodi WHERE esecuzione_id IN (${id}) ORDER BY esecuzione_id, ordine`,
  );
  return componi(righe, nodi);
}

/** Ultima esecuzione valida per ciascuna recensione. */
export function ultimePerChiave(): Map<string, Esecuzione> {
  const righe = tutteLeRighe<RigaEsecuzione>(
    `SELECT ${CAMPI} FROM (
       SELECT ${CAMPI},
              ROW_NUMBER() OVER (PARTITION BY recensione_chiave
                                 ORDER BY quando DESC, rowid DESC) AS n
         FROM esecuzioni
        WHERE annullata_il IS NULL AND archiviata_il IS NULL
     ) WHERE n = 1`,
  );
  if (righe.length === 0) return new Map();
  const id = righe.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(",");
  const nodi = tutteLeRighe<RigaNodo>(
    `SELECT esecuzione_id, azione_codice, tipo, stato, messaggio,
            chiamata_metodo, chiamata_url, chiamata_corpo, durata_ms
       FROM esiti_nodi WHERE esecuzione_id IN (${id}) ORDER BY esecuzione_id, ordine`,
  );
  return new Map(componi(righe, nodi).map((e) => [e.recensione.chiave, e]));
}

export type Scostamento = {
  azioneCodice: string;
  parametro: string;
  valoreVersione: string;
  valoreUsato: string;
};

/**
 * Scrive un'esecuzione con i suoi nodi. Testata e nodi in una sola
 * transazione: una testata senza nodi sarebbe un'esecuzione senza storia.
 */
export function inserisciEsecuzione(
  e: Esecuzione,
  opzioni: {
    regolaVersioneId?: number | null;
    recensioneId?: number | null;
    operatoreId?: number;
    scostamenti?: Scostamento[];
  } = {},
): void {
  const durata = e.nodi.reduce((s, n) => s + (n.durataMs || 0), 0);

  transazione(() => {
    esegui(
      `INSERT INTO esecuzioni
         (id, quando, modo, esito, regola_id, regola_nome, regola_versione_id, operatore_id,
          recensione_id, recensione_chiave, recensione_nome, recensione_stelle,
          recensione_sede, recensione_testo, testo_modificato, durata_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      e.id,
      e.quando,
      e.modo,
      e.esito,
      e.regolaId,
      e.regolaNome,
      opzioni.regolaVersioneId ?? null,
      opzioni.operatoreId ?? 1,
      opzioni.recensioneId ?? null,
      e.recensione.chiave,
      e.recensione.nome,
      e.recensione.stelle ?? null,
      e.recensione.sede,
      e.recensione.testo,
      e.testoModificato ? 1 : 0,
      durata,
    );

    e.nodi.forEach((n, i) => {
      esegui(
        `INSERT INTO esiti_nodi
           (esecuzione_id, ordine, azione_codice, tipo, stato, messaggio,
            chiamata_metodo, chiamata_url, chiamata_corpo, durata_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        e.id,
        i,
        n.azioneId,
        n.tipo,
        n.stato,
        n.messaggio,
        n.chiamata?.metodo ?? null,
        n.chiamata?.url ?? null,
        n.chiamata?.corpo ?? null,
        n.durataMs ?? 0,
      );
    });

    for (const s of opzioni.scostamenti ?? []) {
      esegui(
        `INSERT INTO esecuzioni_scostamenti
           (esecuzione_id, azione_codice, parametro, valore_versione, valore_usato)
         VALUES (?,?,?,?,?)`,
        e.id,
        s.azioneCodice,
        s.parametro,
        s.valoreVersione,
        s.valoreUsato,
      );
    }
  });
}

/** Toglie l'esecuzione dal registro senza cancellarla: la recensione torna in coda. */
export function annullaEsecuzione(id: string): void {
  esegui("UPDATE esecuzioni SET annullata_il = ? WHERE id = ? AND annullata_il IS NULL", adesso(), id);
}

/** Svuota il registro visibile. Le righe restano, marcate. */
export function archiviaTutte(): void {
  esegui(
    "UPDATE esecuzioni SET archiviata_il = ? WHERE archiviata_il IS NULL AND annullata_il IS NULL",
    adesso(),
  );
}

/** Aggancia le esecuzioni orfane alle recensioni comparse dopo. */
export function agganciaRecensioni(): void {
  esegui(
    `UPDATE esecuzioni SET recensione_id = (
       SELECT r.id FROM recensioni r WHERE r.chiave = esecuzioni.recensione_chiave)
     WHERE recensione_id IS NULL
       AND EXISTS (SELECT 1 FROM recensioni r WHERE r.chiave = esecuzioni.recensione_chiave)`,
  );
}
