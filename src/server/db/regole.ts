import { createHash } from "node:crypto";
import { esegui, tutteLeRighe, transazione, unaRiga } from "./connessione";
import type { Azione, Regola, TipoAzione } from "@/server/automation/types";
import { adesso } from "@/server/tempo";

// Le regole: stato corrente in `regole`/`azioni`/`azioni_parametri`, storico
// immutabile in `regole_versioni`.
//
// Prima le regole vivevano in un JSON sovrascritto a ogni salvataggio: cambiare
// il testo di una risposta cancellava per sempre quello vecchio, e le
// esecuzioni passate non sapevano più con quale testo erano girate. Adesso ogni
// salvataggio lascia una fotografia, e ogni esecuzione punta alla sua.

export type Origine = "iniziale" | "interfaccia" | "ripristino" | "importazione";

/**
 * Impronta del contenuto di una regola.
 *
 * Serve a NON creare una versione quando non è cambiato niente: il pannello
 * rimanda tutti i parametri a ogni salvataggio, anche solo aprendo e chiudendo
 * un riquadro. Senza deduplica la cronologia diventa illeggibile in una
 * settimana di uso normale.
 */
export function improntaRegola(r: Regola): string {
  const canonico = JSON.stringify({
    nome: r.nome,
    attiva: r.attiva,
    stelle: [...r.condizione.stelle].sort((a, b) => a - b),
    testo: r.condizione.testo,
    azioni: r.azioni.map((a) => ({
      id: a.id,
      tipo: a.tipo,
      // Parametri ordinati per nome: due oggetti uguali scritti in ordine
      // diverso non devono sembrare due versioni diverse.
      parametri: Object.keys(a.parametri)
        .sort()
        .map((k) => [k, a.parametri[k]]),
    })),
  });
  return createHash("sha1").update(canonico).digest("hex");
}

// ------------------------------------------------------------------ lettura

export function leggiRegole(): Regola[] {
  const regole = tutteLeRighe<{
    id: string;
    nome: string;
    attiva: number;
    condizione_testo: string;
  }>("SELECT id, nome, attiva, condizione_testo FROM regole ORDER BY ordine, id");

  if (regole.length === 0) return [];

  const stelle = tutteLeRighe<{ regola_id: string; stelle: number }>(
    "SELECT regola_id, stelle FROM regole_stelle ORDER BY regola_id, stelle",
  );
  const azioni = tutteLeRighe<{ id: number; regola_id: string; codice: string; tipo: string }>(
    "SELECT id, regola_id, codice, tipo FROM azioni ORDER BY regola_id, ordine",
  );
  const parametri = tutteLeRighe<{ azione_id: number; nome: string; valore: string }>(
    "SELECT azione_id, nome, valore FROM azioni_parametri",
  );

  const perAzione = new Map<number, Record<string, string>>();
  for (const p of parametri) {
    const m = perAzione.get(p.azione_id) ?? {};
    m[p.nome] = p.valore;
    perAzione.set(p.azione_id, m);
  }

  const azioniPerRegola = new Map<string, Azione[]>();
  for (const a of azioni) {
    const arr = azioniPerRegola.get(a.regola_id) ?? [];
    arr.push({
      id: a.codice,
      tipo: a.tipo as TipoAzione,
      parametri: perAzione.get(a.id) ?? {},
    });
    azioniPerRegola.set(a.regola_id, arr);
  }

  const stellePerRegola = new Map<string, number[]>();
  for (const s of stelle) {
    const arr = stellePerRegola.get(s.regola_id) ?? [];
    arr.push(s.stelle);
    stellePerRegola.set(s.regola_id, arr);
  }

  return regole.map((r) => ({
    id: r.id,
    nome: r.nome,
    attiva: r.attiva === 1,
    condizione: {
      stelle: stellePerRegola.get(r.id) ?? [],
      testo: r.condizione_testo as Regola["condizione"]["testo"],
    },
    azioni: azioniPerRegola.get(r.id) ?? [],
  }));
}

// ---------------------------------------------------------------- scrittura

/**
 * Riscrive tutte le regole e registra una versione per ognuna che è cambiata.
 *
 * Cancella e reinserisce invece di riconciliare le differenze: sono cinque
 * regole, e la riconciliazione costerebbe molto più codice di quanto valga.
 * Tutto in una transazione, quindi o passa tutto o non passa niente.
 */
export function scriviRegole(regole: Regola[], origine: Origine = "interfaccia", nota = ""): void {
  const ora = adesso();
  const improntePrecedenti = new Map<string, string>();
  const attivaPrecedente = new Map<string, number>();

  for (const v of tutteLeRighe<{ regola_id: string; impronta: string; attiva: number }>(
    `SELECT v.regola_id, v.impronta, v.attiva FROM regole_versioni v
      JOIN (SELECT regola_id, MAX(numero) AS ultimo FROM regole_versioni GROUP BY regola_id) u
        ON u.regola_id = v.regola_id AND u.ultimo = v.numero`,
  )) {
    improntePrecedenti.set(v.regola_id, v.impronta);
    attivaPrecedente.set(v.regola_id, v.attiva);
  }

  transazione(() => {
    esegui("DELETE FROM regole");

    regole.forEach((r, i) => {
      esegui(
        `INSERT INTO regole (id, nome, attiva, condizione_testo, ordine, creata_il, aggiornata_il)
         VALUES (?,?,?,?,?,?,?)`,
        r.id,
        r.nome,
        r.attiva ? 1 : 0,
        r.condizione.testo,
        i,
        ora,
        ora,
      );

      for (const s of [...new Set(r.condizione.stelle)].sort((a, b) => a - b)) {
        esegui("INSERT INTO regole_stelle (regola_id, stelle) VALUES (?,?)", r.id, s);
      }

      r.azioni.forEach((a, j) => {
        const res = esegui(
          "INSERT INTO azioni (regola_id, codice, tipo, ordine) VALUES (?,?,?,?)",
          r.id,
          a.id,
          a.tipo,
          j,
        );
        const azioneId = Number(res.lastInsertRowid);
        for (const [nome, valore] of Object.entries(a.parametri ?? {})) {
          esegui(
            "INSERT INTO azioni_parametri (azione_id, nome, valore) VALUES (?,?,?)",
            azioneId,
            nome,
            // La stringa vuota è un valore, non un dato mancante.
            valore ?? "",
          );
        }
      });

      // ---- versione, solo se qualcosa è cambiato davvero -------------------
      const impronta = improntaRegola(r);
      const precedente = improntePrecedenti.get(r.id);
      if (precedente === impronta) return;

      const numero =
        (unaRiga<{ n: number }>(
          "SELECT coalesce(MAX(numero), 0) AS n FROM regole_versioni WHERE regola_id = ?",
          r.id,
        )?.n ?? 0) + 1;

      // Accendere o spegnere una regola crea comunque una versione: è la
      // domanda che ci si pone più spesso ("da quando è attiva?"). Marcarla
      // come 'stato' permette di nasconderla quando si guardano i cambi di
      // testo.
      const soloStato =
        precedente !== undefined && attivaPrecedente.get(r.id) !== (r.attiva ? 1 : 0);
      const tipoModifica =
        origine === "ripristino"
          ? "ripristino"
          : precedente === undefined
            ? "creazione"
            : soloStato
              ? "stato"
              : "contenuto";

      esegui(
        `INSERT INTO regole_versioni
           (regola_id, numero, nome, attiva, condizione, azioni, impronta,
            tipo_modifica, origine, nota, creata_il, creata_da)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        r.id,
        numero,
        r.nome,
        r.attiva ? 1 : 0,
        JSON.stringify(r.condizione),
        JSON.stringify(r.azioni),
        impronta,
        tipoModifica,
        origine,
        nota,
        ora,
      );
    });
  });
}

// ------------------------------------------------------------------ storico

export type VersioneRegola = {
  id: number;
  regolaId: string;
  numero: number;
  nome: string;
  attiva: boolean;
  tipoModifica: string;
  origine: string;
  nota: string;
  creataIl: string;
  chi: string;
  esecuzioni: number;
  regola: Regola;
};

function componiVersione(r: {
  id: number;
  regola_id: string;
  numero: number;
  nome: string;
  attiva: number;
  condizione: string;
  azioni: string;
  tipo_modifica: string;
  origine: string;
  nota: string;
  creata_il: string;
  chi: string;
  esecuzioni: number;
}): VersioneRegola {
  return {
    id: r.id,
    regolaId: r.regola_id,
    numero: r.numero,
    nome: r.nome,
    attiva: r.attiva === 1,
    tipoModifica: r.tipo_modifica,
    origine: r.origine,
    nota: r.nota,
    creataIl: r.creata_il,
    chi: r.chi,
    esecuzioni: r.esecuzioni,
    regola: {
      id: r.regola_id,
      nome: r.nome,
      attiva: r.attiva === 1,
      condizione: JSON.parse(r.condizione) as Regola["condizione"],
      azioni: JSON.parse(r.azioni) as Azione[],
    },
  };
}

const SELECT_VERSIONI = `
  SELECT v.id, v.regola_id, v.numero, v.nome, v.attiva, v.condizione, v.azioni,
         v.tipo_modifica, v.origine, v.nota, v.creata_il, o.nome AS chi,
         (SELECT COUNT(*) FROM esecuzioni e WHERE e.regola_versione_id = v.id) AS esecuzioni
    FROM regole_versioni v
    JOIN operatori o ON o.id = v.creata_da`;

export function storicoRegola(regolaId: string): VersioneRegola[] {
  return tutteLeRighe<Parameters<typeof componiVersione>[0]>(
    `${SELECT_VERSIONI} WHERE v.regola_id = ? ORDER BY v.numero DESC`,
    regolaId,
  ).map(componiVersione);
}

export function ultimeVersioni(limite = 40): VersioneRegola[] {
  return tutteLeRighe<Parameters<typeof componiVersione>[0]>(
    `${SELECT_VERSIONI} ORDER BY v.creata_il DESC, v.id DESC LIMIT ?`,
    limite,
  ).map(componiVersione);
}

export function versione(id: number): VersioneRegola | null {
  const r = unaRiga<Parameters<typeof componiVersione>[0]>(`${SELECT_VERSIONI} WHERE v.id = ?`, id);
  return r ? componiVersione(r) : null;
}

/** Versione in vigore adesso per una regola, per agganciarci un'esecuzione. */
export function versioneCorrente(regolaId: string): number | null {
  const r = unaRiga<{ id: number }>(
    "SELECT id FROM regole_versioni WHERE regola_id = ? ORDER BY numero DESC LIMIT 1",
    regolaId,
  );
  return r?.id ?? null;
}

// -------------------------------------------------------------------- diff

export type DifferenzaNodo = {
  azioneId: string;
  tipo: string;
  parametro: string;
  cambiamento: "aggiunto" | "rimosso" | "modificato" | "spostato";
  prima: string;
  dopo: string;
};

/**
 * Confronto leggibile fra due versioni, appaiando i nodi per codice azione.
 *
 * Si fa qui e non in SQL perché entrambi i lati sono nostri e le regole sono
 * cinque: una FULL OUTER JOIN con i NULL da gestire renderebbe il confronto
 * più difficile da leggere di quanto lo renda comodo da interrogare.
 */
export function confronta(da: Regola, a: Regola): DifferenzaNodo[] {
  const out: DifferenzaNodo[] = [];
  const indiceDa = new Map(da.azioni.map((x, i) => [x.id, { azione: x, posizione: i }]));
  const indiceA = new Map(a.azioni.map((x, i) => [x.id, { azione: x, posizione: i }]));

  for (const [id, { azione, posizione }] of indiceA) {
    const vecchio = indiceDa.get(id);
    if (!vecchio) {
      out.push({
        azioneId: id,
        tipo: azione.tipo,
        parametro: "",
        cambiamento: "aggiunto",
        prima: "",
        dopo: azione.tipo,
      });
      continue;
    }
    const nomi = new Set([
      ...Object.keys(vecchio.azione.parametri ?? {}),
      ...Object.keys(azione.parametri ?? {}),
    ]);
    for (const nome of [...nomi].sort()) {
      const prima = vecchio.azione.parametri?.[nome] ?? "";
      const dopo = azione.parametri?.[nome] ?? "";
      if (prima !== dopo) {
        out.push({
          azioneId: id,
          tipo: azione.tipo,
          parametro: nome,
          cambiamento: "modificato",
          prima,
          dopo,
        });
      }
    }
    if (vecchio.posizione !== posizione) {
      out.push({
        azioneId: id,
        tipo: azione.tipo,
        parametro: "",
        cambiamento: "spostato",
        prima: `posizione ${vecchio.posizione + 1}`,
        dopo: `posizione ${posizione + 1}`,
      });
    }
  }

  for (const [id, { azione }] of indiceDa) {
    if (!indiceA.has(id)) {
      out.push({
        azioneId: id,
        tipo: azione.tipo,
        parametro: "",
        cambiamento: "rimosso",
        prima: azione.tipo,
        dopo: "",
      });
    }
  }

  return out;
}
