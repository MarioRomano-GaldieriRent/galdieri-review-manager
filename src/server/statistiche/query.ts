import "@/server/db/avvio";
import { conta, tutteLeRighe, unaRiga } from "@/server/db/connessione";

// Le interrogazioni della pagina Statistiche.
//
// Regola di forma, non negoziabile: si legge SOLO dall'archivio, mai dalla
// finestra live delle ultime 50 email. Mescolare le due basi darebbe numeri
// che cambiano a ogni ricaricamento senza che nessuno sappia spiegare perché.
//
// Seconda regola: ogni funzione restituisce anche la propria BASE, cioè su
// quante righe è calcolata e quante ne ha escluse. Una percentuale senza base
// non è un'informazione, è un'impressione.

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

export function copertura(): Copertura {
  const estremi = unaRiga<{ prima: string | null; ultima: string | null }>(
    "SELECT MIN(prima_vista_il) AS prima, MAX(ultima_vista_il) AS ultima FROM recensioni",
  );
  const sync = unaRiga<{ n: number; giorni: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT substr(iniziata_il,1,10)) AS giorni
       FROM sincronizzazioni`,
  );
  // Le email lette NON si sommano fra le passate: ogni caricamento di pagina
  // rilegge le stesse 50 email, e sommarle direbbe "2000 email lette" dopo
  // quaranta aperture della dashboard. Vale l'ultima passata, che è una
  // fotografia della finestra corrente.
  const ultimaPassata = unaRiga<{ letti: number; scartati: number }>(
    `SELECT messaggi_letti AS letti, messaggi_scartati AS scartati
       FROM sincronizzazioni ORDER BY id DESC LIMIT 1`,
  );

  const prima = estremi?.prima ?? null;
  const ultima = estremi?.ultima ?? null;
  const giorni =
    prima && ultima
      ? Math.max(
          1,
          Math.round((new Date(ultima).getTime() - new Date(prima).getTime()) / 86400000) + 1,
        )
      : 0;

  return {
    primaRaccolta: prima,
    ultimaRaccolta: ultima,
    giorniCoperti: giorni,
    recensioni: conta("SELECT COUNT(*) FROM recensioni"),
    archiviate: conta("SELECT COUNT(*) FROM recensioni WHERE archiviata_il IS NOT NULL"),
    ricostruite: conta("SELECT COUNT(*) FROM recensioni WHERE testo_troncato = 1"),
    sincronizzazioni: sync?.n ?? 0,
    messaggiLetti: ultimaPassata?.letti ?? 0,
    messaggiScartati: ultimaPassata?.scartati ?? 0,
    senzaPunteggio: conta("SELECT COUNT(*) FROM recensioni WHERE stelle IS NULL"),
    senzaSede: conta("SELECT COUNT(*) FROM recensioni WHERE sede_id = 0"),
    possibiliDoppioni: conta(
      `SELECT COUNT(*) FROM (SELECT impronta FROM recensioni
         WHERE impronta IS NOT NULL GROUP BY impronta HAVING COUNT(*) > 1)`,
    ),
    giorniSenzaRaccolta: Math.max(0, giorni - (sync?.giorni ?? 0)),
  };
}

// ------------------------------------------------------------------ volume

export type Settimana = { settimana: string; recensioni: number; negative: number };

/**
 * Volume per settimana ISO.
 *
 * La settimana in corso viene marcata a parte dalla pagina e tenuta fuori
 * dalle medie: è sempre parziale, e messa accanto alle altre si legge come un
 * crollo che non è mai avvenuto.
 */
export function perSettimana(limite = 26): Settimana[] {
  return tutteLeRighe<Settimana>(
    `SELECT settimana_iso AS settimana, COUNT(*) AS recensioni,
            SUM(CASE WHEN stelle <= 2 THEN 1 ELSE 0 END) AS negative
       FROM recensioni WHERE settimana_iso <> ''
      GROUP BY settimana_iso ORDER BY settimana_iso DESC LIMIT ?`,
    limite,
  ).reverse();
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

export function punteggi(): Punteggi {
  const distribuzione = tutteLeRighe<{ stelle: number; quante: number }>(
    `SELECT stelle, COUNT(*) AS quante FROM recensioni
      WHERE stelle IS NOT NULL GROUP BY stelle ORDER BY stelle DESC`,
  );
  const base = distribuzione.reduce((s, d) => s + d.quante, 0);
  const somma = distribuzione.reduce((s, d) => s + d.stelle * d.quante, 0);

  return {
    distribuzione,
    senzaPunteggio: conta("SELECT COUNT(*) FROM recensioni WHERE stelle IS NULL"),
    base,
    // La media si mostra solo con la sua base accanto, e non è il punteggio
    // pubblico del profilo Google: è la media delle recensioni arrivate via
    // email, che è un insieme diverso.
    media: base > 0 ? somma / base : null,
    cinqueSenzaCommento: conta("SELECT COUNT(*) FROM recensioni WHERE stelle = 5 AND ha_testo = 0"),
    cinqueConCommento: conta("SELECT COUNT(*) FROM recensioni WHERE stelle = 5 AND ha_testo = 1"),
    negative: conta("SELECT COUNT(*) FROM recensioni WHERE stelle <= 2"),
  };
}

// -------------------------------------------------------------------- sedi

export type RigaSede = {
  sede: string;
  recensioni: number;
  negative: number;
  media: number | null;
  /** Sotto le 20 recensioni non si mostra nessuna percentuale. */
  baseSufficiente: boolean;
};

export const SOGLIA_SEDE = 20;

export function perSede(): RigaSede[] {
  return tutteLeRighe<{
    sede: string;
    recensioni: number;
    negative: number;
    media: number | null;
    con_punteggio: number;
  }>(
    `SELECT s.nome AS sede, COUNT(*) AS recensioni,
            SUM(CASE WHEN r.stelle <= 2 THEN 1 ELSE 0 END) AS negative,
            AVG(r.stelle) AS media,
            SUM(CASE WHEN r.stelle IS NOT NULL THEN 1 ELSE 0 END) AS con_punteggio
       FROM recensioni r JOIN sedi s ON s.id = r.sede_id
      GROUP BY s.id ORDER BY recensioni DESC, s.nome`,
  ).map((r) => ({
    sede: r.sede,
    recensioni: r.recensioni,
    negative: r.negative,
    media: r.con_punteggio > 0 ? r.media : null,
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

export function lingue(): Lingue {
  const righe = tutteLeRighe<{ lingua: string; quante: number }>(
    `SELECT coalesce(l.nome, 'non rilevata') AS lingua, COUNT(*) AS quante
       FROM recensioni r LEFT JOIN lingue l ON l.codice = r.lingua_codice
      WHERE r.ha_testo = 1
      GROUP BY r.lingua_codice ORDER BY quante DESC`,
  );

  // Mediana e non media: un solo commento lunghissimo sposta la media e non
  // dice niente su come scrivono i clienti.
  const lunghezze = tutteLeRighe<{ n: number }>(
    `SELECT length(trim(coalesce(nullif(testo_italiano,''), testo_originale))) AS n
       FROM recensioni WHERE ha_testo = 1 ORDER BY n`,
  ).map((r) => r.n);

  return {
    righe,
    conCommento: conta("SELECT COUNT(*) FROM recensioni WHERE ha_testo = 1"),
    soloPunteggio: conta("SELECT COUNT(*) FROM recensioni WHERE ha_testo = 0"),
    lunghezzaMediana: lunghezze.length > 0 ? lunghezze[Math.floor(lunghezze.length / 2)] : null,
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

export function lavorazione(): Lavorazione {
  return {
    flussiSimulati: conta(
      "SELECT COUNT(*) FROM esecuzioni WHERE modo = 'simulazione' AND annullata_il IS NULL",
    ),
    flussiReali: conta(
      "SELECT COUNT(*) FROM esecuzioni WHERE modo = 'reale' AND annullata_il IS NULL",
    ),
    // Pubblicata davvero = la RISPOSTA PUBBLICA al cliente è andata a buon
    // fine. Solo google.rispondi: un inoltro a Cherubina o una PUT su
    // Freshdesk sono scritture riuscite, ma il cliente non vede niente.
    // Contarle qui trasformerebbe ogni escalation in una "risposta
    // pubblicata", che è esattamente la confusione che questo numero deve
    // impedire.
    pubblicateDavvero: conta(
      `SELECT COUNT(DISTINCT n.esecuzione_id) FROM esiti_nodi n
         JOIN esecuzioni e ON e.id = n.esecuzione_id
        WHERE n.stato = 'ok' AND n.tipo = 'google.rispondi'
          AND e.modo = 'reale' AND e.annullata_il IS NULL`,
    ),
    // Scritture riuscite di qualunque tipo: utile, ma è un'altra domanda e
    // porta un'altra etichetta.
    scrittureRiuscite: conta(
      `SELECT COUNT(DISTINCT n.esecuzione_id) FROM esiti_nodi n
         JOIN esecuzioni e ON e.id = n.esecuzione_id
         JOIN tipi_azione t ON t.tipo = n.tipo AND t.scrittura = 1
        WHERE n.stato = 'ok' AND e.modo = 'reale' AND e.annullata_il IS NULL`,
    ),
    conErrore: conta("SELECT COUNT(*) FROM esecuzioni WHERE esito = 'errore' AND annullata_il IS NULL"),
    riscritture: conta(
      "SELECT COUNT(*) FROM esecuzioni WHERE testo_modificato = 1 AND annullata_il IS NULL",
    ),
    copertePerRegola: tutteLeRighe<{ regola: string; quante: number }>(
      `SELECT regola_nome AS regola, COUNT(*) AS quante FROM esecuzioni
        WHERE annullata_il IS NULL GROUP BY regola_nome ORDER BY quante DESC`,
    ),
    // freshdesk.trovaTicket è una GET: gira davvero anche in simulazione,
    // quindi questi due numeri sono affidabili da subito. Le esecuzioni
    // annullate restano fuori, come in tutti gli altri numeri della sezione:
    // altrimenti una prova rimessa in coda e rifatta conterebbe due volte.
    ticketTrovati: conta(
      `SELECT COUNT(*) FROM esiti_nodi n JOIN esecuzioni e ON e.id = n.esecuzione_id
        WHERE n.tipo = 'freshdesk.trovaTicket' AND n.messaggio LIKE 'Ticket #%'
          AND e.annullata_il IS NULL`,
    ),
    ticketNonTrovati: conta(
      `SELECT COUNT(*) FROM esiti_nodi n JOIN esecuzioni e ON e.id = n.esecuzione_id
        WHERE n.tipo = 'freshdesk.trovaTicket' AND n.messaggio LIKE 'Nessun ticket%'
          AND e.annullata_il IS NULL`,
    ),
    erroriPerNodo: tutteLeRighe<{ titolo: string; quanti: number }>(
      `SELECT t.titolo, COUNT(*) AS quanti FROM esiti_nodi n
         JOIN tipi_azione t ON t.tipo = n.tipo
         JOIN esecuzioni e ON e.id = n.esecuzione_id
        WHERE n.stato = 'errore' AND e.annullata_il IS NULL
        GROUP BY n.tipo ORDER BY quanti DESC`,
    ),
  };
}

/** Quante recensioni sono coperte da una regola attiva: non dipende dalla modalità. */
export function coperturaRegole(): { coperte: number; scoperte: number } {
  const coperte = conta(
    `SELECT COUNT(*) FROM recensioni r
      WHERE r.archiviata_il IS NULL AND EXISTS (
        SELECT 1 FROM regole g JOIN regole_stelle s ON s.regola_id = g.id
         WHERE g.attiva = 1 AND s.stelle = r.stelle
           AND (g.condizione_testo = 'qualsiasi'
             OR (g.condizione_testo = 'con'   AND r.ha_testo = 1)
             OR (g.condizione_testo = 'senza' AND r.ha_testo = 0)))`,
  );
  const totale = conta("SELECT COUNT(*) FROM recensioni WHERE archiviata_il IS NULL");
  return { coperte, scoperte: totale - coperte };
}
