import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Schema del database e migrazioni.
//
// Ogni migrazione si applica una volta sola: il numero raggiunto vive in
// `PRAGMA user_version`, dentro il file stesso. Per cambiare lo schema si
// ACCODA un elemento con versione successiva; le migrazioni già rilasciate non
// si modificano e non si riordinano mai, altrimenti due database che hanno
// visto la stessa applicazione in momenti diversi divergono in silenzio.
//
// Tre regole valgono per tutto il DDL qui sotto:
//   STRICT      — i tipi sono veri. Senza, SQLite accetta "cinque" in una
//                 colonna INTEGER e l'errore si scopre mesi dopo in un grafico.
//   niente date — SQLite non ha un tipo data: TEXT in ISO-8601, sempre UTC con
//                 la Z finale, perché l'ordinamento alfabetico coincide con
//                 quello cronologico solo se il formato è uniforme.
//   niente bool — INTEGER 0/1 con CHECK. node:sqlite rifiuta i booleani.
// ---------------------------------------------------------------------------

type Migrazione = {
  versione: number;
  descrizione: string;
  /** Sincrona: node:sqlite non ha API asincrone. */
  applica: (c: DatabaseSync) => void;
};

// ============================================================ v1 — impianto

const V1_DIMENSIONI = `
-- Sedi di noleggio. La fonte di verità resta src/server/automation/sedi.ts,
-- ricavata dai ticket reali: questa tabella la insegue, non la sostituisce.
CREATE TABLE sedi (
  id                INTEGER PRIMARY KEY,
  nome              TEXT    NOT NULL,
  nome_normalizzato TEXT    NOT NULL UNIQUE,
  tag_freshdesk     TEXT    NOT NULL DEFAULT '',
  creata_il         TEXT    NOT NULL
) STRICT;

-- Sentinella: sede_id resta NOT NULL anche quando l'oggetto dell'email non
-- fa riconoscere la sede, così quelle recensioni non spariscono dietro
-- una JOIN — sparire in silenzio è il modo peggiore di perdere dati.
INSERT OR IGNORE INTO sedi (id, nome, nome_normalizzato, tag_freshdesk, creata_il)
VALUES (0, '(sede non riconosciuta)', '', '', '1970-01-01T00:00:00.000Z');

CREATE TABLE lingue (
  codice   TEXT    PRIMARY KEY,
  nome     TEXT    NOT NULL,
  italiana INTEGER NOT NULL DEFAULT 0 CHECK (italiana IN (0,1))
) STRICT, WITHOUT ROWID;

CREATE TABLE etichette (
  id                TEXT    PRIMARY KEY,
  nome              TEXT    NOT NULL,
  oggetto_contiene  TEXT    NOT NULL DEFAULT '',
  mittente_contiene TEXT    NOT NULL DEFAULT '',
  ordine            INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Catalogo dei tipi di nodo, seminato da CATALOGO in automation/types.ts.
CREATE TABLE tipi_azione (
  tipo      TEXT    PRIMARY KEY,
  servizio  TEXT    NOT NULL CHECK (servizio IN ('freshdesk','google','email','sistema')),
  titolo    TEXT    NOT NULL,
  scrittura INTEGER NOT NULL CHECK (scrittura IN (0,1))
) STRICT, WITHOUT ROWID;
`;

const V1_OPERATORI = `
-- Chi agisce. Oggi non c'è login e c'è un solo operatore, "sistema" con id 1,
-- che è il DEFAULT di ogni colonna di attribuzione. L'app funziona identica a
-- prima; il giorno in cui si accende l'autenticazione bastano righe nuove,
-- senza migrazioni distruttive e senza righe orfane da riempire a posteriori.
CREATE TABLE operatori (
  id             INTEGER PRIMARY KEY,
  chiave         TEXT    NOT NULL UNIQUE,
  nome           TEXT    NOT NULL,
  email          TEXT,
  tipo           TEXT    NOT NULL DEFAULT 'persona'
                   CHECK (tipo IN ('sistema','persona','servizio')),
  -- Etichetta informativa ('posta', 'customer care'), NON un permesso.
  ruolo          TEXT    NOT NULL DEFAULT '',
  attivo         INTEGER NOT NULL DEFAULT 1 CHECK (attivo IN (0,1)),
  di_sistema     INTEGER NOT NULL DEFAULT 0 CHECK (di_sistema IN (0,1)),
  creato_il      TEXT    NOT NULL,
  disattivato_il TEXT
) STRICT;

INSERT OR IGNORE INTO operatori (id, chiave, nome, tipo, ruolo, di_sistema, creato_il)
VALUES (1, 'sistema', 'Sistema', 'sistema', 'operatore implicito', 1, '1970-01-01T00:00:00.000Z');

CREATE TRIGGER operatore_sistema_non_eliminabile
BEFORE DELETE ON operatori WHEN OLD.di_sistema = 1
BEGIN SELECT RAISE(ABORT, 'operatore di sistema: non eliminabile'); END;

-- Identità di un ALTRO sistema: numerica, gestita su Freshdesk, e non sempre
-- una persona (80000162477 è la casella Customer Care). Tenerla separata dagli
-- operatori evita di inventare operatori finti; il collegamento è facoltativo
-- e NULL è la condizione normale, non un difetto dei dati.
CREATE TABLE agenti_freshdesk (
  id_freshdesk  TEXT    PRIMARY KEY,
  nome          TEXT    NOT NULL,
  email         TEXT,
  gruppo        TEXT    NOT NULL DEFAULT '',
  attivo        INTEGER NOT NULL DEFAULT 1 CHECK (attivo IN (0,1)),
  operatore_id  INTEGER REFERENCES operatori(id) ON DELETE SET NULL,
  aggiornato_il TEXT    NOT NULL
) STRICT, WITHOUT ROWID;

-- Timeline di ciò che le persone fanno. Non sostituisce le colonne
-- operatore_id delle tabelle di dominio: ospita gli atti che non hanno una
-- tabella propria (approvazioni, ripristini, prove di connessione).
CREATE TABLE registro_attivita (
  id           INTEGER PRIMARY KEY,
  quando       TEXT    NOT NULL,
  operatore_id INTEGER NOT NULL DEFAULT 1 REFERENCES operatori(id) ON DELETE RESTRICT,
  azione       TEXT    NOT NULL,
  oggetto_tipo TEXT,
  oggetto_id   TEXT,
  dettaglio    TEXT    NOT NULL DEFAULT ''
) STRICT;

CREATE TRIGGER attivita_immutabile_upd
BEFORE UPDATE ON registro_attivita
BEGIN SELECT RAISE(ABORT, 'il registro attività non si modifica'); END;
CREATE TRIGGER attivita_immutabile_del
BEFORE DELETE ON registro_attivita
BEGIN SELECT RAISE(ABORT, 'il registro attività non si cancella'); END;
`;

const V1_RECENSIONI = `
-- Il fatto centrale. Oggi le recensioni non esistono da nessuna parte: si
-- rileggono da Graph a ogni caricamento e appena escono dalle ultime 50 email
-- sono perse. Qui restano, ed è su questo che si fanno le statistiche.
CREATE TABLE recensioni (
  id                   INTEGER PRIMARY KEY,
  -- conversationId: bersaglio dell'upsert. La stessa recensione riletta da
  -- Graph aggiorna questa riga, non ne crea una seconda.
  chiave               TEXT    NOT NULL UNIQUE,
  origine              TEXT    NOT NULL DEFAULT 'google'
                         CHECK (origine IN ('google','trustpilot')),
  messaggio_id         TEXT    NOT NULL DEFAULT '',
  oggetto              TEXT    NOT NULL DEFAULT '',
  -- Nessuna FK verso etichette: cancellare l'ultima etichetta dal pannello
  -- svuoterebbe quella tabella e il primo salvataggio violerebbe il vincolo.
  etichetta_id         TEXT,

  nome_cliente         TEXT    NOT NULL DEFAULT '(senza nome)',
  stelle               INTEGER CHECK (stelle IS NULL OR stelle BETWEEN 1 AND 5),
  punteggio_testo      TEXT    NOT NULL DEFAULT '',
  testo_originale      TEXT    NOT NULL DEFAULT '',
  testo_italiano       TEXT,
  inglese_di_google    TEXT    NOT NULL DEFAULT '',
  gia_italiano         INTEGER NOT NULL DEFAULT 0 CHECK (gia_italiano IN (0,1)),
  lingua_codice        TEXT    REFERENCES lingue(codice) ON UPDATE CASCADE,
  sede_id              INTEGER NOT NULL DEFAULT 0 REFERENCES sedi(id) ON UPDATE CASCADE,

  numero_messaggi      INTEGER NOT NULL DEFAULT 1,
  ha_risposta          INTEGER NOT NULL DEFAULT 0 CHECK (ha_risposta IN (0,1)),
  risolto              INTEGER NOT NULL DEFAULT 0 CHECK (risolto IN (0,1)),

  ricevuta_il          TEXT    NOT NULL,
  -- Stesso istante in ora italiana: i raggruppamenti per giorno e settimana si
  -- fanno su questo, altrimenti a cavallo di mezzanotte finiscono nel giorno
  -- sbagliato.
  ricevuta_il_locale   TEXT    NOT NULL,
  giorno_settimana     INTEGER NOT NULL DEFAULT 0 CHECK (giorno_settimana BETWEEN 0 AND 6),
  settimana_iso        TEXT    NOT NULL DEFAULT '',
  -- Quando l'abbiamo vista per la prima volta. NON si aggiorna mai più: è la
  -- differenza fra "quando è arrivata" e "da quando la sappiamo", ed è ciò che
  -- impedisce ai primi giorni di raccolta di sembrare un boom di recensioni.
  prima_vista_il       TEXT    NOT NULL,
  ultima_vista_il      TEXT    NOT NULL,
  risposta_rilevata_il TEXT,
  risolto_rilevato_il  TEXT,

  -- Fuori dalla coda operativa: storico importato o archiviata a mano.
  archiviata_il        TEXT,
  motivo_archiviazione TEXT    NOT NULL DEFAULT '',
  -- 1 quando il testo è stato ricostruito dal registro esecuzioni, dove è
  -- tagliato a 400 caratteri: senza questo flag fra un anno sembrerebbero
  -- recensioni scritte così.
  testo_troncato       INTEGER NOT NULL DEFAULT 0 CHECK (testo_troncato IN (0,1)),
  -- Serve SOLO a segnalare possibili doppioni in pagina, mai a unire righe:
  -- due 5 stelle senza commento della stessa sede sono legittimamente uguali.
  impronta             TEXT,

  ha_testo    INTEGER GENERATED ALWAYS AS (
                CASE WHEN length(trim(coalesce(nullif(testo_italiano,''), testo_originale))) > 0
                     THEN 1 ELSE 0 END) STORED,
  anno_mese   TEXT    GENERATED ALWAYS AS (substr(ricevuta_il_locale, 1, 7))  STORED,
  data_locale TEXT    GENERATED ALWAYS AS (substr(ricevuta_il_locale, 1, 10)) STORED,
  ora_locale  INTEGER GENERATED ALWAYS AS (CAST(substr(ricevuta_il_locale, 12, 2) AS INTEGER)) STORED
) STRICT;

-- Ogni passata di lettura dalla posta lascia una riga: senza, la copertura dei
-- dati non è ricostruibile e qualunque "tempo di risposta" è indifendibile.
CREATE TABLE sincronizzazioni (
  id                    INTEGER PRIMARY KEY,
  iniziata_il           TEXT    NOT NULL,
  terminata_il          TEXT,
  etichetta_id          TEXT,
  messaggi_letti        INTEGER NOT NULL DEFAULT 0,
  messaggi_interpretati INTEGER NOT NULL DEFAULT 0,
  messaggi_scartati     INTEGER NOT NULL DEFAULT 0,
  recensioni_viste      INTEGER NOT NULL DEFAULT 0,
  recensioni_nuove      INTEGER NOT NULL DEFAULT 0,
  recensioni_aggiornate INTEGER NOT NULL DEFAULT 0,
  esito                 TEXT    NOT NULL DEFAULT 'ok' CHECK (esito IN ('ok','errore')),
  errore                TEXT
) STRICT;
`;

const V1_REGOLE = `
-- Stato CORRENTE delle regole: è quello che l'applicazione legge a ogni
-- esecuzione. Lo storico sta in regole_versioni.
CREATE TABLE regole (
  id               TEXT    PRIMARY KEY,
  nome             TEXT    NOT NULL,
  attiva           INTEGER NOT NULL DEFAULT 0 CHECK (attiva IN (0,1)),
  condizione_testo TEXT    NOT NULL DEFAULT 'qualsiasi'
                     CHECK (condizione_testo IN ('con','senza','qualsiasi')),
  -- regolaPer() prende la PRIMA regola attiva che copre la recensione:
  -- l'ordine è semantico, non estetico.
  ordine           INTEGER NOT NULL DEFAULT 0,
  creata_il        TEXT    NOT NULL,
  aggiornata_il    TEXT    NOT NULL
) STRICT;

CREATE TABLE regole_stelle (
  regola_id TEXT    NOT NULL REFERENCES regole(id) ON DELETE CASCADE ON UPDATE CASCADE,
  stelle    INTEGER NOT NULL CHECK (stelle BETWEEN 1 AND 5),
  PRIMARY KEY (regola_id, stelle)
) STRICT, WITHOUT ROWID;

CREATE TABLE azioni (
  id        INTEGER PRIMARY KEY,
  regola_id TEXT    NOT NULL REFERENCES regole(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- Azione.id ('a1', 'e5'): unico dentro la regola, è la chiave con cui si
  -- appaiano le versioni per calcolare un diff. Non va mai riciclato.
  codice    TEXT    NOT NULL,
  tipo      TEXT    NOT NULL REFERENCES tipi_azione(tipo) ON UPDATE CASCADE,
  -- L'ORDINE È IL FLUSSO: email.rispondi deve stare prima dei nodi Freshdesk,
  -- perché è quella risposta a far nascere il ticket che gli altri cercano.
  ordine    INTEGER NOT NULL,
  UNIQUE (regola_id, codice)
) STRICT;

CREATE TABLE azioni_parametri (
  azione_id INTEGER NOT NULL REFERENCES azioni(id) ON DELETE CASCADE,
  nome      TEXT    NOT NULL,
  -- La stringa vuota è un VALORE, non un dato mancante: in email.rispondi il
  -- destinatario vuoto significa "segui il Reply-To dell'email".
  valore    TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (azione_id, nome)
) STRICT, WITHOUT ROWID;

-- Storico dei flussi: una fotografia immutabile a ogni salvataggio.
-- Senza, cambiare il testo di una risposta cancella per sempre quello vecchio
-- e le esecuzioni passate non sanno più con quale testo sono girate.
--
-- Il contenuto è una fotografia JSON e non tabelle normalizzate: le regole
-- sono cinque, il confronto fra due versioni si fa in TypeScript dove si
-- controllano entrambi i lati, e in cambio la scrittura di una versione resta
-- un solo INSERT — quindi atomica per costruzione.
CREATE TABLE regole_versioni (
  id            INTEGER PRIMARY KEY,
  regola_id     TEXT    NOT NULL,
  -- Progressivo per regola, da 1. È il numero che si mostra: "v3".
  numero        INTEGER NOT NULL,
  nome          TEXT    NOT NULL,
  attiva        INTEGER NOT NULL CHECK (attiva IN (0,1)),
  condizione    TEXT    NOT NULL,   -- JSON {stelle:[], testo:''}
  azioni        TEXT    NOT NULL,   -- JSON [{id,tipo,parametri}]
  -- sha1 della forma canonica: serve a NON creare una versione quando non è
  -- cambiato niente. Il pannello rimanda tutti i parametri a ogni salvataggio,
  -- anche solo aprendo e chiudendo un riquadro: senza deduplica la cronologia
  -- diventa illeggibile in una settimana.
  impronta      TEXT    NOT NULL,
  tipo_modifica TEXT    NOT NULL DEFAULT 'contenuto'
                  CHECK (tipo_modifica IN ('creazione','contenuto','stato','ripristino')),
  origine       TEXT    NOT NULL DEFAULT 'interfaccia'
                  CHECK (origine IN ('iniziale','interfaccia','ripristino','importazione')),
  nota          TEXT    NOT NULL DEFAULT '',
  creata_il     TEXT    NOT NULL,
  creata_da     INTEGER NOT NULL DEFAULT 1 REFERENCES operatori(id) ON DELETE RESTRICT,
  UNIQUE (regola_id, numero)
) STRICT;

-- Una versione è un fatto avvenuto: correggere "solo un refuso" cancellerebbe
-- la verità dell'esecuzione che quel refuso l'ha davvero pubblicato.
CREATE TRIGGER versione_immutabile_upd
BEFORE UPDATE ON regole_versioni
BEGIN SELECT RAISE(ABORT, 'una versione di regola non si modifica: creane una nuova'); END;
CREATE TRIGGER versione_immutabile_del
BEFORE DELETE ON regole_versioni
BEGIN SELECT RAISE(ABORT, 'una versione di regola non si cancella'); END;
`;

const V1_ESECUZIONI = `
CREATE TABLE esecuzioni (
  id                TEXT    PRIMARY KEY,
  quando            TEXT    NOT NULL,
  modo              TEXT    NOT NULL CHECK (modo  IN ('simulazione','reale')),
  esito             TEXT    NOT NULL CHECK (esito IN ('ok','errore')),

  -- Nessuna FK verso regole: l'inoltro manuale costruisce al volo una regola
  -- 'inoltro-manuale' che non è persistita, e una FK farebbe fallire ogni
  -- inoltro.
  regola_id         TEXT    NOT NULL,
  regola_nome       TEXT    NOT NULL,
  -- Versione esatta con cui il flusso è girato. NULL per l'inoltro manuale.
  -- RESTRICT: finché esiste l'esecuzione, la sua versione non si cancella.
  regola_versione_id INTEGER REFERENCES regole_versioni(id) ON DELETE RESTRICT,
  operatore_id      INTEGER NOT NULL DEFAULT 1 REFERENCES operatori(id) ON DELETE RESTRICT,

  recensione_id     INTEGER REFERENCES recensioni(id) ON DELETE SET NULL,
  recensione_chiave TEXT    NOT NULL,
  recensione_nome   TEXT    NOT NULL DEFAULT '',
  recensione_stelle INTEGER CHECK (recensione_stelle IS NULL OR recensione_stelle BETWEEN 1 AND 5),
  recensione_sede   TEXT    NOT NULL DEFAULT '',
  recensione_testo  TEXT    NOT NULL DEFAULT '',

  testo_modificato  INTEGER NOT NULL DEFAULT 0 CHECK (testo_modificato IN (0,1)),
  durata_ms         INTEGER NOT NULL DEFAULT 0,
  -- "Rimetti in coda" e "svuota registro" NON cancellano: marcano. Se il
  -- registro è la base delle statistiche, una DELETE è perdita irreversibile.
  annullata_il      TEXT,
  archiviata_il     TEXT
) STRICT;

CREATE TABLE esiti_nodi (
  id              INTEGER PRIMARY KEY,
  esecuzione_id   TEXT    NOT NULL REFERENCES esecuzioni(id) ON DELETE CASCADE,
  ordine          INTEGER NOT NULL,
  azione_codice   TEXT    NOT NULL,
  tipo            TEXT    NOT NULL REFERENCES tipi_azione(tipo) ON UPDATE CASCADE,
  stato           TEXT    NOT NULL CHECK (stato IN ('ok','errore','saltato','simulato')),
  messaggio       TEXT    NOT NULL DEFAULT '',
  chiamata_metodo TEXT,
  chiamata_url    TEXT,
  chiamata_corpo  TEXT,
  durata_ms       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (esecuzione_id, ordine)
) STRICT;

-- Il testo riscritto a mano prima di eseguire. Senza questa tabella
-- l'esecuzione direbbe "versione 3" mentre è partito un testo diverso da
-- quello della versione 3, e la ricostruzione sarebbe una bugia.
CREATE TABLE esecuzioni_scostamenti (
  esecuzione_id   TEXT NOT NULL REFERENCES esecuzioni(id) ON DELETE CASCADE,
  azione_codice   TEXT NOT NULL,
  parametro       TEXT NOT NULL,
  valore_versione TEXT NOT NULL,
  valore_usato    TEXT NOT NULL,
  PRIMARY KEY (esecuzione_id, azione_codice, parametro)
) STRICT, WITHOUT ROWID;
`;

const V1_IMPOSTAZIONI = `
-- Catalogo delle chiavi note e, per ciascuna, se è un segreto. È l'unica fonte
-- di verità su cosa sia segreto, e la legge il database stesso nei trigger:
-- né l'interfaccia né il codice possono contraddirla.
CREATE TABLE impostazioni_catalogo (
  chiave        TEXT PRIMARY KEY,
  etichetta     TEXT NOT NULL,
  segreto       INTEGER NOT NULL CHECK (segreto IN (0,1)),
  variabile_env TEXT NOT NULL DEFAULT ''
) STRICT, WITHOUT ROWID;

-- Impostazioni in vigore: SOLO campi non segreti.
--
-- I segreti (client secret Microsoft, API key Freshdesk, chiave Azure, refresh
-- token Google) restano fuori dal database, nel .env. Il motivo è pratico: il
-- .db è il file che circola — lo si copia per i backup, lo si apre con un
-- visualizzatore SQLite per guardare le statistiche. Un SELECT fatto per
-- curiosità non deve poter stampare una credenziale.
--
-- Riga assente e valore vuoto significano entrambi "usa il .env", esattamente
-- come già fa pick() in settings.ts.
CREATE TABLE impostazioni (
  chiave        TEXT    PRIMARY KEY REFERENCES impostazioni_catalogo(chiave) ON DELETE RESTRICT,
  valore        TEXT    NOT NULL DEFAULT '',
  aggiornata_il TEXT    NOT NULL,
  aggiornata_da INTEGER NOT NULL DEFAULT 1 REFERENCES operatori(id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

-- Barriera: una chiave segreta non può proprio entrare in questa tabella.
CREATE TRIGGER impostazione_niente_segreti_ins
BEFORE INSERT ON impostazioni
WHEN (SELECT segreto FROM impostazioni_catalogo WHERE chiave = NEW.chiave) = 1
BEGIN SELECT RAISE(ABORT, 'campo segreto: il valore non si salva nel database'); END;

CREATE TRIGGER impostazione_niente_segreti_upd
BEFORE UPDATE ON impostazioni
WHEN (SELECT segreto FROM impostazioni_catalogo WHERE chiave = NEW.chiave) = 1
BEGIN SELECT RAISE(ABORT, 'campo segreto: il valore non si salva nel database'); END;

-- Storico: una riga per ogni cambiamento, segreti compresi. Per i segreti si
-- registrano solo il fatto, l'autore e l'istante — mai il valore.
CREATE TABLE impostazioni_storico (
  id                INTEGER PRIMARY KEY,
  chiave            TEXT    NOT NULL,
  -- Copia del flag al momento del fatto: se domani una chiave smettesse di
  -- essere segreta, le righe vecchie devono restare vincolate.
  segreto           INTEGER NOT NULL CHECK (segreto IN (0,1)),
  quando            TEXT    NOT NULL,
  operatore_id      INTEGER NOT NULL DEFAULT 1 REFERENCES operatori(id) ON DELETE RESTRICT,
  azione            TEXT    NOT NULL CHECK (azione IN ('impostata','modificata','svuotata')),
  valore_precedente TEXT,
  valore_nuovo      TEXT,
  -- Per i segreti è tutto ciò che si registra: c'era qualcosa prima, c'è
  -- qualcosa adesso. Nessuna informazione sul contenuto — nemmeno un hash,
  -- nemmeno la lunghezza, nemmeno gli ultimi caratteri.
  presente_prima    INTEGER NOT NULL DEFAULT 0 CHECK (presente_prima IN (0,1)),
  presente_dopo     INTEGER NOT NULL DEFAULT 0 CHECK (presente_dopo  IN (0,1)),
  -- Barriera dichiarativa, sempre attiva, non aggirabile.
  CHECK (segreto = 0 OR (valore_precedente IS NULL AND valore_nuovo IS NULL))
) STRICT;

-- Barriera: il flag non può essere dichiarato a piacere da chi scrive, deve
-- coincidere col catalogo. Così non basta passare segreto = 0 per aggirare
-- il CHECK qui sopra.
CREATE TRIGGER storico_segreto_coerente
BEFORE INSERT ON impostazioni_storico
WHEN NEW.segreto <> coalesce((SELECT segreto FROM impostazioni_catalogo WHERE chiave = NEW.chiave), 0)
BEGIN SELECT RAISE(ABORT, 'flag segreto incoerente con il catalogo'); END;

CREATE TRIGGER imp_storico_immutabile_upd
BEFORE UPDATE ON impostazioni_storico
BEGIN SELECT RAISE(ABORT, 'lo storico delle impostazioni non si modifica'); END;
CREATE TRIGGER imp_storico_immutabile_del
BEFORE DELETE ON impostazioni_storico
BEGIN SELECT RAISE(ABORT, 'lo storico delle impostazioni non si cancella'); END;

CREATE TABLE traduzioni (
  -- sha1(testo.trim()).slice(0,20): IDENTICA a quella di oggi. Ricalcolarla
  -- con un altro algoritmo significherebbe ripagare Azure per tutto lo storico.
  chiave          TEXT    PRIMARY KEY,
  testo_originale TEXT    NOT NULL DEFAULT '',
  italiano        TEXT    NOT NULL,
  lingua_rilevata TEXT,
  creata_il       TEXT    NOT NULL,
  usata_il        TEXT    NOT NULL,
  usi             INTEGER NOT NULL DEFAULT 1
) STRICT, WITHOUT ROWID;

-- Registro dei travasi una tantum dai vecchi file JSON: rende la migrazione
-- idempotente anche se i file venissero ripristinati a mano.
CREATE TABLE travasi (
  file        TEXT    PRIMARY KEY,
  eseguito_il TEXT    NOT NULL,
  righe       INTEGER NOT NULL DEFAULT 0,
  nota        TEXT    NOT NULL DEFAULT ''
) STRICT, WITHOUT ROWID;
`;

const V1_INDICI = `
CREATE INDEX i_recensioni_ricevuta    ON recensioni (ricevuta_il_locale DESC);
CREATE INDEX i_recensioni_anno_mese   ON recensioni (anno_mese);
CREATE INDEX i_recensioni_settimana   ON recensioni (settimana_iso);
CREATE INDEX i_recensioni_sede_data   ON recensioni (sede_id, ricevuta_il_locale DESC);
CREATE INDEX i_recensioni_stelle_data ON recensioni (stelle, ricevuta_il_locale DESC);
CREATE INDEX i_recensioni_lingua      ON recensioni (lingua_codice);
CREATE INDEX i_recensioni_etichetta   ON recensioni (etichetta_id, ricevuta_il_locale DESC);
CREATE INDEX i_recensioni_origine     ON recensioni (origine, ricevuta_il_locale DESC);
CREATE INDEX i_recensioni_impronta    ON recensioni (impronta) WHERE impronta IS NOT NULL;
CREATE INDEX i_recensioni_coda        ON recensioni (ricevuta_il_locale DESC) WHERE archiviata_il IS NULL;

CREATE INDEX i_esecuzioni_quando      ON esecuzioni (quando DESC);
CREATE INDEX i_esecuzioni_recensione  ON esecuzioni (recensione_chiave, quando DESC) WHERE annullata_il IS NULL;
CREATE INDEX i_esecuzioni_regola      ON esecuzioni (regola_id, quando DESC);
CREATE INDEX i_esecuzioni_modo_esito  ON esecuzioni (modo, esito, quando DESC);
CREATE INDEX i_esiti_nodi_tipo_stato  ON esiti_nodi (tipo, stato);
CREATE INDEX i_esiti_nodi_esecuzione  ON esiti_nodi (esecuzione_id, ordine);

CREATE INDEX i_regole_attive          ON regole (attiva, ordine);
CREATE INDEX i_regole_stelle_inverso  ON regole_stelle (stelle, regola_id);
CREATE INDEX i_azioni_regola          ON azioni (regola_id, ordine);
CREATE INDEX i_versioni_regola        ON regole_versioni (regola_id, numero DESC);
CREATE INDEX i_traduzioni_lingua      ON traduzioni (lingua_rilevata);
CREATE INDEX i_sincronizzazioni_data  ON sincronizzazioni (iniziata_il DESC);
CREATE INDEX i_attivita_quando        ON registro_attivita (quando DESC);
CREATE INDEX i_imp_storico_chiave     ON impostazioni_storico (chiave, quando DESC);
`;

const V1_VISTE = `
-- Definizione UNICA di "automatica / a mano / da lavorare": due schermate non
-- devono poter dare due numeri diversi alla stessa domanda.
CREATE VIEW vista_recensioni AS
SELECT r.id, r.chiave, r.origine, r.nome_cliente, r.stelle, r.ha_testo,
       r.testo_originale, r.testo_italiano, r.testo_troncato,
       s.nome AS sede, s.tag_freshdesk,
       coalesce(l.nome, 'non rilevata') AS lingua, r.lingua_codice,
       r.ricevuta_il, r.ricevuta_il_locale, r.anno_mese, r.data_locale,
       r.settimana_iso, r.giorno_settimana, r.ora_locale,
       r.prima_vista_il, r.ha_risposta, r.risolto, r.risposta_rilevata_il,
       r.archiviata_il, r.impronta,
       CASE WHEN r.risposta_rilevata_il IS NOT NULL
            THEN round((julianday(r.risposta_rilevata_il) - julianday(r.ricevuta_il)) * 24.0, 1)
       END AS ore_alla_risposta,
       CASE WHEN EXISTS (SELECT 1 FROM esecuzioni e
                          WHERE e.recensione_chiave = r.chiave
                            AND e.annullata_il IS NULL
                            AND e.modo = 'reale' AND e.esito = 'ok') THEN 'automatica'
            WHEN r.ha_risposta = 1 THEN 'a mano'
            ELSE 'da lavorare' END AS gestione
FROM recensioni r
JOIN sedi s ON s.id = r.sede_id
LEFT JOIN lingue l ON l.codice = r.lingua_codice;
`;

const MIGRAZIONI: Migrazione[] = [
  {
    versione: 1,
    descrizione: "impianto: recensioni, regole con storico, esecuzioni, impostazioni, operatori",
    applica: (c) => {
      // exec() e non prepare(): prepare() eseguirebbe SOLO la prima istruzione,
      // dichiarando successo, e lo schema resterebbe monco per sempre.
      c.exec(V1_DIMENSIONI);
      c.exec(V1_OPERATORI);
      c.exec(V1_RECENSIONI);
      c.exec(V1_REGOLE);
      c.exec(V1_ESECUZIONI);
      c.exec(V1_IMPOSTAZIONI);
      c.exec(V1_INDICI);
      c.exec(V1_VISTE);
    },
  },
];

/** Versione di schema attesa da questo codice. */
export const VERSIONE_SCHEMA = MIGRAZIONI[MIGRAZIONI.length - 1].versione;

export function applicaMigrazioni(c: DatabaseSync): void {
  const riga = c.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  let versione = Number(riga?.user_version ?? 0);

  for (const m of MIGRAZIONI) {
    if (m.versione <= versione) continue;

    // I PRAGMA non accettano parametri: `PRAGMA user_version = ?` è un errore
    // di sintassi. Il numero finisce interpolato, quindi va validato.
    if (!Number.isSafeInteger(m.versione) || m.versione <= 0) {
      throw new Error(`Numero di migrazione non valido: ${String(m.versione)}`);
    }

    c.exec("BEGIN IMMEDIATE");
    try {
      m.applica(c);
      // Nella stessa transazione del DDL: o avanzano insieme, o niente.
      c.exec(`PRAGMA user_version = ${m.versione}`);
      c.exec("COMMIT");
    } catch (errore) {
      try {
        c.exec("ROLLBACK");
      } catch {
        /* SQLite può aver già annullato da sé */
      }
      throw new Error(`Migrazione ${m.versione} (${m.descrizione}) non riuscita.`, {
        cause: errore,
      });
    }
    versione = m.versione;
  }
}
