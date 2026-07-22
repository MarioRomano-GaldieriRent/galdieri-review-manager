import { createHash } from "node:crypto";
import { esegui, tutteLeRighe, transazione, unaRiga } from "./connessione";
import { agganciaRecensioni } from "./esecuzioni";
import { normalizzaSede } from "./seed";
import { tagSede } from "@/server/automation/sedi";
import type { Recensione } from "@/server/reviews/load";
import { adesso, aOraItaliana, giornoSettimana, settimanaIso } from "@/server/tempo";

// Archivio delle recensioni.
//
// Le recensioni continuano ad arrivare da Microsoft Graph: questa non è una
// seconda fonte, è la memoria. Graph mostra le ultime 50 email e basta; qui
// resta tutto quello che è passato di lì almeno una volta.
//
// Tre regole di prudenza governano l'aggiornamento, e nascono tutte dallo
// stesso fatto: la stessa recensione viene riletta decine di volte, e ogni
// rilettura potrebbe essere più povera della precedente (la traduzione può
// essere spenta, il testo può mancare).
//
//   1. i flag non tornano indietro     — MAX(vecchio, nuovo)
//   2. un testo pieno non viene svuotato — COALESCE(NULLIF(nuovo,''), vecchio)
//   3. prima_vista_il non si tocca mai   — è la data che distingue "quando è
//      arrivata" da "da quando la sappiamo"
//
// Niente qui solleva: l'archiviazione non deve poter far fallire il
// caricamento delle pagine.

export function improntaRecensione(r: Recensione): string {
  const testo = (r.italiano ?? r.originale ?? "").trim().toLowerCase();
  return createHash("sha1")
    .update(`${r.nome}|${r.stelle ?? ""}|${testo}|${r.sede}`)
    .digest("hex")
    .slice(0, 20);
}

/** Id della sede, creandola se è nuova. 0 quando non è riconoscibile. */
function idSede(nome: string): number {
  const normalizzato = normalizzaSede(nome);
  if (!normalizzato) return 0;

  const esistente = unaRiga<{ id: number }>(
    "SELECT id FROM sedi WHERE nome_normalizzato = ?",
    normalizzato,
  );
  if (esistente) return esistente.id;

  const res = esegui(
    "INSERT INTO sedi (nome, nome_normalizzato, tag_freshdesk, creata_il) VALUES (?,?,?,?)",
    nome.trim(),
    normalizzato,
    tagSede(nome),
    adesso(),
  );
  return Number(res.lastInsertRowid);
}

export type ContatoriLettura = {
  letti: number;
  interpretati: number;
  scartati: number;
};

/**
 * Archivia le recensioni appena lette dalla posta e registra la passata.
 *
 * Va chiamata DOPO tutto l'I/O di rete: la transazione è sincrona e cortissima
 * di proposito, perché un await al suo interno farebbe entrare altre richieste
 * nella stessa transazione.
 */
export function salvaRecensioni(
  recensioni: Recensione[],
  etichettaId: string,
  contatori: ContatoriLettura,
): void {
  const ora = adesso();

  try {
    transazione(() => {
      const sync = esegui(
        `INSERT INTO sincronizzazioni
           (iniziata_il, terminata_il, etichetta_id, messaggi_letti, messaggi_interpretati,
            messaggi_scartati, recensioni_viste)
         VALUES (?,?,?,?,?,?,?)`,
        ora,
        ora,
        etichettaId || null,
        contatori.letti,
        contatori.interpretati,
        contatori.scartati,
        recensioni.length,
      );

      let nuove = 0;
      let aggiornate = 0;

      for (const r of recensioni) {
        if (!r.chiave) continue;

        const lingua = (r.lingua || "").trim();
        if (lingua) {
          esegui(
            "INSERT INTO lingue (codice, nome, italiana) VALUES (?,?,?) ON CONFLICT(codice) DO NOTHING",
            lingua,
            lingua,
            lingua === "it" ? 1 : 0,
          );
        }

        const gia = unaRiga<{ id: number }>("SELECT id FROM recensioni WHERE chiave = ?", r.chiave);
        const locale = aOraItaliana(r.ricevutaIl);

        esegui(
          `INSERT INTO recensioni (
             chiave, origine, messaggio_id, oggetto, etichetta_id,
             nome_cliente, stelle, punteggio_testo, testo_originale, testo_italiano,
             inglese_di_google, gia_italiano, lingua_codice, sede_id,
             numero_messaggi, ha_risposta, risolto,
             ricevuta_il, ricevuta_il_locale, giorno_settimana, settimana_iso,
             prima_vista_il, ultima_vista_il, risposta_rilevata_il, risolto_rilevato_il, impronta)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(chiave) DO UPDATE SET
             messaggio_id      = excluded.messaggio_id,
             oggetto           = excluded.oggetto,
             etichetta_id      = excluded.etichetta_id,
             nome_cliente      = excluded.nome_cliente,
             stelle            = coalesce(excluded.stelle, recensioni.stelle),
             punteggio_testo   = coalesce(nullif(excluded.punteggio_testo,''), recensioni.punteggio_testo),
             testo_originale   = coalesce(nullif(excluded.testo_originale,''), recensioni.testo_originale),
             -- una traduzione che manca non deve cancellare quella che c'era
             testo_italiano    = coalesce(nullif(excluded.testo_italiano,''), recensioni.testo_italiano),
             inglese_di_google = coalesce(nullif(excluded.inglese_di_google,''), recensioni.inglese_di_google),
             gia_italiano      = excluded.gia_italiano,
             lingua_codice     = coalesce(excluded.lingua_codice, recensioni.lingua_codice),
             sede_id           = CASE WHEN excluded.sede_id <> 0 THEN excluded.sede_id ELSE recensioni.sede_id END,
             numero_messaggi   = MAX(excluded.numero_messaggi, recensioni.numero_messaggi),
             -- flag monotoni: una risposta data non viene mai ritirata
             ha_risposta       = MAX(excluded.ha_risposta, recensioni.ha_risposta),
             risolto           = MAX(excluded.risolto, recensioni.risolto),
             -- La riga ricostruita dal registro porta come "ricevuta" la data
             -- dell'esecuzione, che è posteriore all'arrivo vero. Quando la
             -- recensione viene riletta dalla posta vince la data più antica,
             -- che è quella giusta.
             ricevuta_il        = MIN(excluded.ricevuta_il, recensioni.ricevuta_il),
             ricevuta_il_locale = CASE WHEN excluded.ricevuta_il < recensioni.ricevuta_il
                                       THEN excluded.ricevuta_il_locale ELSE recensioni.ricevuta_il_locale END,
             giorno_settimana   = CASE WHEN excluded.ricevuta_il < recensioni.ricevuta_il
                                       THEN excluded.giorno_settimana ELSE recensioni.giorno_settimana END,
             settimana_iso      = CASE WHEN excluded.ricevuta_il < recensioni.ricevuta_il
                                       THEN excluded.settimana_iso ELSE recensioni.settimana_iso END,
             -- Rileggendola per intero dalla posta, la ricostruzione dal
             -- registro smette di essere tale: torna in coda e il testo non è
             -- più troncato.
             archiviata_il = CASE WHEN recensioni.motivo_archiviazione = 'ricostruita-dal-registro'
                                  THEN NULL ELSE recensioni.archiviata_il END,
             motivo_archiviazione = CASE WHEN recensioni.motivo_archiviazione = 'ricostruita-dal-registro'
                                         THEN '' ELSE recensioni.motivo_archiviazione END,
             testo_troncato = CASE WHEN nullif(excluded.testo_originale,'') IS NOT NULL
                                   THEN 0 ELSE recensioni.testo_troncato END,
             ultima_vista_il   = excluded.ultima_vista_il,
             risposta_rilevata_il = CASE
               WHEN recensioni.risposta_rilevata_il IS NOT NULL THEN recensioni.risposta_rilevata_il
               WHEN excluded.ha_risposta = 1 THEN excluded.ultima_vista_il END,
             risolto_rilevato_il = CASE
               WHEN recensioni.risolto_rilevato_il IS NOT NULL THEN recensioni.risolto_rilevato_il
               WHEN excluded.risolto = 1 THEN excluded.ultima_vista_il END,
             impronta          = excluded.impronta`,
          r.chiave,
          "google",
          r.messaggioId ?? "",
          r.oggetto ?? "",
          etichettaId || null,
          r.nome || "(senza nome)",
          r.stelle ?? null,
          r.punteggioTesto ?? "",
          r.originale ?? "",
          r.italiano ?? null,
          r.ingleseDiGoogle ?? "",
          r.giaItaliano ? 1 : 0,
          lingua || null,
          idSede(r.sede ?? ""),
          r.numeroMessaggi ?? 1,
          r.haRisposta ? 1 : 0,
          r.risolto ? 1 : 0,
          r.ricevutaIl,
          locale,
          giornoSettimana(r.ricevutaIl),
          settimanaIso(r.ricevutaIl),
          // (settimanaIso converte già in ora italiana al suo interno)
          ora,
          ora,
          r.haRisposta ? ora : null,
          r.risolto ? ora : null,
          improntaRecensione(r),
        );

        if (gia) aggiornate += 1;
        else nuove += 1;
      }

      esegui(
        "UPDATE sincronizzazioni SET recensioni_nuove = ?, recensioni_aggiornate = ? WHERE id = ?",
        nuove,
        aggiornate,
        Number(sync.lastInsertRowid),
      );

      // Le esecuzioni importate dal vecchio registro non avevano una
      // recensione a cui agganciarsi: adesso può esserci.
      agganciaRecensioni();
    });
  } catch (e) {
    console.error("[recensioni] archiviazione non riuscita:", e);
  }
}

// ------------------------------------------------------------------ lettura

export type RecensioneArchiviata = Recensione & {
  primaVistaIl: string;
  archiviataIl: string | null;
  testoTroncato: boolean;
};

const CAMPI = `chiave, nome_cliente, stelle, punteggio_testo, testo_originale, testo_italiano,
               gia_italiano, lingua_codice, inglese_di_google, oggetto, messaggio_id,
               numero_messaggi, ha_risposta, risolto, ricevuta_il, prima_vista_il,
               archiviata_il, testo_troncato,
               (SELECT nome FROM sedi s WHERE s.id = recensioni.sede_id) AS sede`;

type Riga = {
  chiave: string;
  nome_cliente: string;
  stelle: number | null;
  punteggio_testo: string;
  testo_originale: string;
  testo_italiano: string | null;
  gia_italiano: number;
  lingua_codice: string | null;
  inglese_di_google: string;
  oggetto: string;
  messaggio_id: string;
  numero_messaggi: number;
  ha_risposta: number;
  risolto: number;
  ricevuta_il: string;
  prima_vista_il: string;
  archiviata_il: string | null;
  testo_troncato: number;
  sede: string | null;
};

function componi(r: Riga): RecensioneArchiviata {
  return {
    chiave: r.chiave,
    nome: r.nome_cliente,
    stelle: r.stelle,
    punteggioTesto: r.punteggio_testo,
    originale: r.testo_originale,
    italiano: r.testo_italiano,
    giaItaliano: r.gia_italiano === 1,
    lingua: r.lingua_codice ?? "",
    ingleseDiGoogle: r.inglese_di_google,
    sede: r.sede && r.sede !== "(sede non riconosciuta)" ? r.sede : "",
    oggetto: r.oggetto,
    ricevutaIl: r.ricevuta_il,
    messaggioId: r.messaggio_id,
    numeroMessaggi: r.numero_messaggi,
    haRisposta: r.ha_risposta === 1,
    risolto: r.risolto === 1,
    primaVistaIl: r.prima_vista_il,
    archiviataIl: r.archiviata_il,
    testoTroncato: r.testo_troncato === 1,
  };
}

/** Una recensione dall'archivio, anche se è uscita dalle ultime 50 email. */
export function leggiRecensione(chiave: string): RecensioneArchiviata | null {
  const r = unaRiga<Riga>(`SELECT ${CAMPI} FROM recensioni WHERE chiave = ?`, chiave);
  return r ? componi(r) : null;
}

/** Recensioni non archiviate, dalla più recente. */
export function leggiArchivio(limite = 200): RecensioneArchiviata[] {
  return tutteLeRighe<Riga>(
    `SELECT ${CAMPI} FROM recensioni WHERE archiviata_il IS NULL
      ORDER BY ricevuta_il DESC LIMIT ?`,
    limite,
  ).map(componi);
}

/** Toglie una recensione dalla coda operativa senza cancellarla. */
export function archiviaRecensione(chiave: string, motivo: string): void {
  esegui(
    `UPDATE recensioni SET archiviata_il = ?, motivo_archiviazione = ?
      WHERE chiave = ? AND archiviata_il IS NULL`,
    adesso(),
    motivo,
    chiave,
  );
}
