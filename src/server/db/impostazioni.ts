import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { esegui, tutteLeRighe, transazione, unaRiga } from "./connessione";
import { eSegreta } from "./seed";
import { adesso } from "@/server/tempo";

// Impostazioni: i valori normali nel database, i segreti fuori.
//
// I segreti (client secret Microsoft, API key Freshdesk, chiave Azure, refresh
// token Google) NON entrano nel .db. Il motivo è pratico, non ideologico: il
// database è il file che circola — lo si copia per i backup, lo si apre con un
// visualizzatore per guardare le statistiche. Un SELECT fatto per curiosità
// non deve poter stampare una credenziale su uno schermo condiviso.
//
// La sede primaria dei segreti resta il .env. Quelli digitati dal pannello
// finiscono in data/segreti.json, che ha lo stesso identico ruolo che aveva
// data/settings.json: file locale, ignorato da git, letto solo da qui.

const FILE_SEGRETI = path.join(process.cwd(), "data", "segreti.json");

export type Etichetta = {
  id: string;
  name: string;
  subjectContains: string;
  fromContains: string;
};

// ------------------------------------------------------------ valori normali

/** Tutte le impostazioni non segrete presenti nel database. */
export function leggiValori(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of tutteLeRighe<{ chiave: string; valore: string }>(
    "SELECT chiave, valore FROM impostazioni",
  )) {
    out[r.chiave] = r.valore;
  }
  return out;
}

export function leggiEtichette(): Etichetta[] {
  return tutteLeRighe<{
    id: string;
    nome: string;
    oggetto_contiene: string;
    mittente_contiene: string;
  }>(
    // L'ordine è semantico: labels[0] è l'etichetta principale in sei punti
    // del codice. Un SELECT senza ORDER BY qui cambierebbe quale casella si
    // legge, in modo imprevedibile.
    "SELECT id, nome, oggetto_contiene, mittente_contiene FROM etichette ORDER BY ordine, id",
  ).map((r) => ({
    id: r.id,
    name: r.nome,
    subjectContains: r.oggetto_contiene,
    fromContains: r.mittente_contiene,
  }));
}

/**
 * Scrive lo snapshot completo: valori non segreti nel database, segreti su
 * file, ed etichette riscritte da capo.
 *
 * Snapshot completo e non UPDATE per singola colonna: il pannello lavora così
 * (carica tutto, muta un pezzo, risalva tutto) ed è quel meccanismo a far
 * funzionare keep(), cioè "campo lasciato vuoto = tieni quello che c'era".
 */
export function scriviImpostazioni(
  valori: Record<string, string>,
  etichette: Etichetta[],
  operatoreId = 1,
): void {
  const ora = adesso();
  const precedenti = leggiValori();

  const segreti: Record<string, string> = {};
  const normali: Record<string, string> = {};
  for (const [chiave, valore] of Object.entries(valori)) {
    if (!eSegreta(chiave)) {
      normali[chiave] = valore;
      continue;
    }
    // Su un campo segreto la stringa vuota significa "non toccarlo" — è
    // quello che dice il pannello con «lascia vuoto per non cambiarlo».
    // Trattarla come un azzeramento scriverebbe nello storico un segreto
    // "svuotato" che nessuno ha toccato, ogni volta che si salva la sezione
    // per cambiare tutt'altro.
    if (valore.trim()) segreti[chiave] = valore;
  }

  transazione(() => {
    for (const [chiave, valore] of Object.entries(normali)) {
      const prima = precedenti[chiave];
      esegui(
        `INSERT INTO impostazioni (chiave, valore, aggiornata_il, aggiornata_da) VALUES (?,?,?,?)
         ON CONFLICT(chiave) DO UPDATE SET
           valore = excluded.valore, aggiornata_il = excluded.aggiornata_il,
           aggiornata_da = excluded.aggiornata_da`,
        chiave,
        valore,
        ora,
        operatoreId,
      );
      if (prima !== valore) {
        registraCambio(chiave, false, prima, valore, ora, operatoreId);
      }
    }

    // Etichette riscritte da capo: sono poche e l'ordine conta. Riconciliare
    // le differenze costerebbe più codice di quanto valga.
    esegui("DELETE FROM etichette");
    etichette.forEach((e, i) => {
      esegui(
        `INSERT INTO etichette (id, nome, oggetto_contiene, mittente_contiene, ordine)
         VALUES (?,?,?,?,?)`,
        e.id,
        e.name,
        e.subjectContains,
        e.fromContains,
        i,
      );
    });
  });

  // I segreti stanno fuori dalla transazione perché stanno fuori dal database.
  if (Object.keys(segreti).length > 0) scriviSegreti(segreti, ora, operatoreId);
}

/**
 * Riga di storico. Per un segreto si registrano solo il fatto, l'autore e
 * l'istante: le colonne dei valori restano vuote per costruzione, e a farlo
 * rispettare è un CHECK del database, non questa funzione.
 */
function registraCambio(
  chiave: string,
  segreto: boolean,
  prima: string | undefined,
  dopo: string,
  quando: string,
  operatoreId: number,
): void {
  const cePrima = Boolean(prima && prima.trim());
  const ceDopo = Boolean(dopo && dopo.trim());
  const azione = !ceDopo ? "svuotata" : cePrima ? "modificata" : "impostata";

  esegui(
    `INSERT INTO impostazioni_storico
       (chiave, segreto, quando, operatore_id, azione, valore_precedente, valore_nuovo,
        presente_prima, presente_dopo)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    chiave,
    segreto ? 1 : 0,
    quando,
    operatoreId,
    azione,
    segreto ? null : (prima ?? null),
    segreto ? null : dopo,
    cePrima ? 1 : 0,
    ceDopo ? 1 : 0,
  );
}

// ------------------------------------------------------------------ segreti

export function leggiSegreti(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(FILE_SEGRETI, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && eSegreta(k)) out[k] = v;
    }
    return out;
  } catch {
    // Non esiste al primo avvio, ed è la condizione normale: i segreti stanno
    // nel .env e il pannello non è mai stato usato per cambiarli.
    return {};
  }
}

function scriviSegreti(nuovi: Record<string, string>, quando: string, operatoreId: number): void {
  const precedenti = leggiSegreti();
  const uniti = { ...precedenti, ...nuovi };

  try {
    mkdirSync(path.dirname(FILE_SEGRETI), { recursive: true });
    writeFileSync(FILE_SEGRETI, JSON.stringify(uniti, null, 2), "utf8");
  } catch (e) {
    console.error("[impostazioni] segreti non salvati:", e);
    return;
  }

  // Nel database va solo la traccia del cambiamento, mai il valore.
  transazione(() => {
    for (const [chiave, valore] of Object.entries(nuovi)) {
      if (precedenti[chiave] !== valore) {
        registraCambio(chiave, true, precedenti[chiave], valore, quando, operatoreId);
      }
    }
  });
}

// ------------------------------------------------------------------ storico

export type CambioImpostazione = {
  chiave: string;
  etichetta: string;
  segreto: boolean;
  quando: string;
  chi: string;
  azione: string;
  valorePrecedente: string | null;
  valoreNuovo: string | null;
  presentePrima: boolean;
  presenteDopo: boolean;
};

export function storicoImpostazioni(limite = 100): CambioImpostazione[] {
  return tutteLeRighe<{
    chiave: string;
    etichetta: string | null;
    segreto: number;
    quando: string;
    chi: string;
    azione: string;
    valore_precedente: string | null;
    valore_nuovo: string | null;
    presente_prima: number;
    presente_dopo: number;
  }>(
    `SELECT s.chiave, c.etichetta, s.segreto, s.quando, o.nome AS chi, s.azione,
            s.valore_precedente, s.valore_nuovo, s.presente_prima, s.presente_dopo
       FROM impostazioni_storico s
       LEFT JOIN impostazioni_catalogo c ON c.chiave = s.chiave
       JOIN operatori o ON o.id = s.operatore_id
      ORDER BY s.quando DESC, s.id DESC
      LIMIT ?`,
    limite,
  ).map((r) => ({
    chiave: r.chiave,
    etichetta: r.etichetta ?? r.chiave,
    segreto: r.segreto === 1,
    quando: r.quando,
    chi: r.chi,
    azione: r.azione,
    valorePrecedente: r.valore_precedente,
    valoreNuovo: r.valore_nuovo,
    presentePrima: r.presente_prima === 1,
    presenteDopo: r.presente_dopo === 1,
  }));
}

/** Da quando è in vigore la modalità operativa attuale. */
export function modoInVigoreDa(): string | null {
  const r = unaRiga<{ quando: string }>(
    `SELECT quando FROM impostazioni_storico
      WHERE chiave = 'modo' ORDER BY quando DESC, id DESC LIMIT 1`,
  );
  return r?.quando ?? null;
}
