import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { conta, esegui, transazione, unaRiga } from "./connessione";
import { scriviRegole } from "./regole";
import { regoleDiDefault } from "@/server/automation/rules";
import type { Esecuzione, Regola } from "@/server/automation/types";
import { adesso, aOraItaliana, giornoSettimana, settimanaIso } from "@/server/tempo";

// Travaso una tantum dai file JSON al database.
//
// Gira una volta sola per file: a travaso riuscito si scrive una riga in
// `travasi` e il file viene RINOMINATO in *.json.migrato, mai cancellato. Se
// qualcuno rimettesse a mano il file originale, la riga in `travasi` impedisce
// comunque di reimportarlo sopra a quello che nel frattempo è cambiato nel
// database.
//
// Per tornare indietro: fermare il server, cancellare data/galdieri.db* e
// togliere i suffissi .migrato. Si torna esattamente a com'era.

const DATA = path.join(process.cwd(), "data");

function giaFatto(file: string): boolean {
  return Boolean(unaRiga("SELECT file FROM travasi WHERE file = ?", file));
}

function segnaFatto(file: string, righe: number, nota = ""): void {
  esegui(
    "INSERT INTO travasi (file, eseguito_il, righe, nota) VALUES (?,?,?,?) ON CONFLICT(file) DO NOTHING",
    file,
    adesso(),
    righe,
    nota,
  );
}

function leggiJson<T>(nome: string): T | null {
  const percorso = path.join(DATA, nome);
  if (!existsSync(percorso)) return null;
  try {
    return JSON.parse(readFileSync(percorso, "utf8")) as T;
  } catch (e) {
    console.error(`[travaso] ${nome} illeggibile:`, e);
    return null;
  }
}

function archiviaFile(nome: string): void {
  const percorso = path.join(DATA, nome);
  if (!existsSync(percorso)) return;
  try {
    renameSync(percorso, `${percorso}.migrato`);
  } catch (e) {
    console.error(`[travaso] ${nome} non rinominato:`, e);
  }
}

// --------------------------------------------------------------- impostazioni

type SettingsJson = {
  mailbox?: string;
  modo?: string;
  labels?: { id: string; name: string; subjectContains: string; fromContains: string }[];
  [sezione: string]: unknown;
};

/**
 * Impostazioni: si importa SOLO se il file esiste.
 *
 * È la regola più importante di tutta la migrazione. Se settings.json non c'è,
 * l'applicazione sta girando sui valori di default e legge le credenziali dal
 * .env. Scrivere righe vuote nel database spegnerebbe quel ripiego e l'app si
 * ritroverebbe senza credenziali per Graph, Freshdesk, Azure e Google — in
 * silenzio, perché una stringa vuota non somiglia a un errore.
 */
function travasaImpostazioni(): void {
  const nome = "settings.json";
  if (giaFatto(nome)) return;
  const s = leggiJson<SettingsJson>(nome);
  if (!s) return;

  const ora = adesso();
  let righe = 0;
  // Segreti trovati nel vecchio settings.json: vanno messi al sicuro nel file
  // dedicato prima di archiviare l'originale.
  const segretiRecuperati: Record<string, string> = {};

  transazione(() => {
    const piatte: Record<string, string> = {};
    if (typeof s.mailbox === "string") piatte.mailbox = s.mailbox;
    if (typeof s.modo === "string") piatte.modo = s.modo === "reale" ? "reale" : "simulazione";

    for (const sezione of ["graph", "translator", "freshdesk", "googleReviews", "automation"]) {
      const v = s[sezione];
      if (!v || typeof v !== "object") continue;
      for (const [k, valore] of Object.entries(v as Record<string, unknown>)) {
        if (typeof valore === "string") piatte[`${sezione}.${k}`] = valore;
      }
    }

    for (const [chiave, valore] of Object.entries(piatte)) {
      // I segreti non entrano nel database: il trigger li rifiuterebbe
      // comunque, ma è meglio non provarci nemmeno. Vanno però SALVATI
      // altrove prima di archiviare il file, altrimenti una chiave inserita
      // dal pannello e non presente nel .env sparirebbe con la migrazione e
      // l'integrazione smetterebbe di funzionare senza spiegazione.
      const segreta = unaRiga<{ segreto: number }>(
        "SELECT segreto FROM impostazioni_catalogo WHERE chiave = ?",
        chiave,
      );
      if (segreta?.segreto === 1) {
        if (valore.trim()) segretiRecuperati[chiave] = valore;
        continue;
      }
      if (!segreta) continue;
      esegui(
        `INSERT INTO impostazioni (chiave, valore, aggiornata_il) VALUES (?,?,?)
         ON CONFLICT(chiave) DO NOTHING`,
        chiave,
        valore,
        ora,
      );
      righe += 1;
    }

    (s.labels ?? []).forEach((l, i) => {
      esegui(
        `INSERT INTO etichette (id, nome, oggetto_contiene, mittente_contiene, ordine)
         VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        l.id,
        l.name,
        l.subjectContains ?? "",
        l.fromContains ?? "",
        i,
      );
      righe += 1;
    });

    segnaFatto(nome, righe);
  });

  // Solo DOPO che i segreti sono stati messi al sicuro si archivia il file
  // originale: se la scrittura fallisce, settings.json resta dov'è ed è
  // ancora possibile recuperarli a mano.
  if (Object.keys(segretiRecuperati).length > 0) {
    if (!salvaSegretiRecuperati(segretiRecuperati)) {
      console.error(
        `[travaso] ${nome} NON archiviato: i segreti che conteneva non sono stati messi al sicuro.`,
      );
      return;
    }
  }

  archiviaFile(nome);
}

/**
 * Salva in data/segreti.json i segreti recuperati dal vecchio settings.json,
 * senza sovrascrivere quelli eventualmente già presenti.
 */
function salvaSegretiRecuperati(segreti: Record<string, string>): boolean {
  const percorso = path.join(DATA, "segreti.json");
  try {
    let esistenti: Record<string, string> = {};
    if (existsSync(percorso)) {
      esistenti = JSON.parse(readFileSync(percorso, "utf8")) as Record<string, string>;
    }
    writeFileSync(percorso, JSON.stringify({ ...segreti, ...esistenti }, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[travaso] segreti non messi al sicuro:", e);
    return false;
  }
}

// ---------------------------------------------------------------- le regole

function travasaRegole(): void {
  const nome = "automation-rules.json";
  if (giaFatto(nome)) return;

  const salvate = leggiJson<Regola[]>(nome);
  const regole = Array.isArray(salvate) && salvate.length > 0 ? salvate : regoleDiDefault();
  const daFile = Boolean(salvate && salvate.length > 0);

  // Le regole di default sono comunque una scelta esplicita, non un vuoto:
  // seminarle dà una versione 1 da cui partire, e da lì lo storico ha senso.
  scriviRegole(regole, daFile ? "importazione" : "iniziale");
  transazione(() => segnaFatto(nome, regole.length, daFile ? "dal file" : "regole di default"));
  if (daFile) archiviaFile(nome);
}

// ----------------------------------------------------------- le esecuzioni

function travasaEsecuzioni(): void {
  const nome = "automation-runs.json";
  if (giaFatto(nome)) return;
  const runs = leggiJson<Esecuzione[]>(nome);
  if (!Array.isArray(runs) || runs.length === 0) {
    transazione(() => segnaFatto(nome, 0, "niente da importare"));
    return;
  }

  transazione(() => {
    for (const e of runs) {
      // Un tipo di nodo tolto nel frattempo dal catalogo farebbe fallire tutta
      // la migrazione per via della chiave esterna: lo si aggiunge muto.
      for (const n of e.nodi ?? []) {
        esegui(
          `INSERT INTO tipi_azione (tipo, servizio, titolo, scrittura) VALUES (?,?,?,0)
           ON CONFLICT(tipo) DO NOTHING`,
          n.tipo,
          n.servizio ?? "sistema",
          n.titolo ?? n.tipo,
        );
      }

      esegui(
        `INSERT INTO esecuzioni
           (id, quando, modo, esito, regola_id, regola_nome, recensione_chiave,
            recensione_nome, recensione_stelle, recensione_sede, recensione_testo,
            testo_modificato, durata_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
        e.id,
        e.quando,
        e.modo === "reale" ? "reale" : "simulazione",
        e.esito === "errore" ? "errore" : "ok",
        e.regolaId,
        e.regolaNome,
        e.recensione.chiave,
        e.recensione.nome ?? "",
        e.recensione.stelle ?? null,
        e.recensione.sede ?? "",
        e.recensione.testo ?? "",
        e.testoModificato ? 1 : 0,
        (e.nodi ?? []).reduce((s, n) => s + (n.durataMs || 0), 0),
      );

      (e.nodi ?? []).forEach((n, i) => {
        esegui(
          `INSERT INTO esiti_nodi
             (esecuzione_id, ordine, azione_codice, tipo, stato, messaggio,
              chiamata_metodo, chiamata_url, chiamata_corpo, durata_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(esecuzione_id, ordine) DO NOTHING`,
          e.id,
          i,
          n.azioneId,
          n.tipo,
          n.stato,
          n.messaggio ?? "",
          n.chiamata?.metodo ?? null,
          n.chiamata?.url ?? null,
          n.chiamata?.corpo ?? null,
          n.durataMs ?? 0,
        );
      });
    }

    // Le recensioni citate dal registro: sono l'unico modo di sapere che sono
    // esistite. Il testo lì è tagliato a 400 caratteri, e va detto: senza il
    // flag, fra un anno sembrerebbero recensioni scritte così.
    const viste = new Map<string, Esecuzione>();
    for (const e of runs) {
      const prima = viste.get(e.recensione.chiave);
      if (!prima || e.quando < prima.quando) viste.set(e.recensione.chiave, e);
    }
    const ora = adesso();
    for (const [chiave, e] of viste) {
      esegui(
        `INSERT INTO recensioni
           (chiave, messaggio_id, oggetto, nome_cliente, stelle, testo_originale,
            ricevuta_il, ricevuta_il_locale, giorno_settimana, settimana_iso,
            prima_vista_il, ultima_vista_il, archiviata_il, motivo_archiviazione, testo_troncato)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
         ON CONFLICT(chiave) DO NOTHING`,
        chiave,
        "",
        "",
        e.recensione.nome ?? "(senza nome)",
        e.recensione.stelle ?? null,
        e.recensione.testo ?? "",
        e.quando,
        aOraItaliana(e.quando),
        giornoSettimana(e.quando),
        settimanaIso(e.quando),
        ora,
        ora,
        ora,
        "ricostruita-dal-registro",
      );
    }

    segnaFatto(nome, runs.length, `${viste.size} recensioni ricostruite`);
  });

  archiviaFile(nome);
}

// ---------------------------------------------------------- le traduzioni

function travasaTraduzioni(): void {
  const nome = "translations.json";
  if (giaFatto(nome)) return;
  const cache = leggiJson<Record<string, { italian: string; detected: string }>>(nome);
  if (!cache) return;

  const voci = Object.entries(cache);
  const ora = adesso();

  transazione(() => {
    for (const [chiave, v] of voci) {
      if (!v || typeof v.italian !== "string") continue;
      const lingua = typeof v.detected === "string" ? v.detected : "";
      if (lingua) {
        esegui(
          "INSERT INTO lingue (codice, nome, italiana) VALUES (?,?,?) ON CONFLICT(codice) DO NOTHING",
          lingua,
          lingua,
          lingua === "it" ? 1 : 0,
        );
      }
      esegui(
        `INSERT INTO traduzioni (chiave, testo_originale, italiano, lingua_rilevata, creata_il, usata_il, usi)
         VALUES (?,?,?,?,?,?,0) ON CONFLICT(chiave) DO NOTHING`,
        // La chiave si COPIA, non si ricalcola: è sha1 del testo tagliato a 20
        // caratteri, e ricalcolarla con un'altra regola significherebbe
        // ripagare Azure per tradurre di nuovo tutto lo storico.
        chiave,
        "",
        v.italian,
        lingua || null,
        ora,
        ora,
      );
    }
    segnaFatto(nome, voci.length);
  });

  archiviaFile(nome);
}

/** Esegue tutti i travasi mancanti. Non solleva: al peggio non importa nulla. */
export function travasaTutto(): void {
  const passi: [string, () => void][] = [
    ["impostazioni", travasaImpostazioni],
    ["regole", travasaRegole],
    ["esecuzioni", travasaEsecuzioni],
    ["traduzioni", travasaTraduzioni],
  ];
  for (const [nome, passo] of passi) {
    try {
      passo();
    } catch (e) {
      console.error(`[travaso] ${nome} non riuscito:`, e);
    }
  }
}

/** Quante righe sono state importate, per il controllo di verifica. */
export function riepilogoTravasi() {
  return {
    regole: conta("SELECT COUNT(*) FROM regole"),
    versioni: conta("SELECT COUNT(*) FROM regole_versioni"),
    esecuzioni: conta("SELECT COUNT(*) FROM esecuzioni"),
    nodi: conta("SELECT COUNT(*) FROM esiti_nodi"),
    traduzioni: conta("SELECT COUNT(*) FROM traduzioni"),
    recensioni: conta("SELECT COUNT(*) FROM recensioni"),
    impostazioni: conta("SELECT COUNT(*) FROM impostazioni"),
  };
}
