import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AnyBulkWriteOperation, Db, Document } from "mongodb";
import type { DocGen } from "./connessione";
import { scriviRegole } from "./regole";
import { regoleDiDefault } from "@/server/automation/rules";

// Travaso una tantum dei dati reali da SQLite (data/galdieri.db) a MongoDB.
//
// Gira all'avvio, dentro il lucchetto, una volta sola: la riga
// travasi/_id="sqlite:galdieri.db" la rende idempotente. Il file SQLite NON
// viene toccato: resta come rete di sicurezza finché non si è verificato che
// MongoDB gira. Per tornare indietro basta rimettere il codice SQLite.
//
// Neutralizza anche la trappola delle regole: la vecchia logica JSON, se
// trovasse `travasi` vuota, riscriverebbe le cinque regole con quelle di
// default. Qui si scrivono subito i marcatori dei tre file JSON, così quella
// logica non parte, e le regole vere non vengono sovrascritte.

const PERCORSO_SQLITE = path.join(process.cwd(), "data", "galdieri.db");
const MARCATORI_JSON = ["settings.json", "automation-rules.json", "translations.json"];

const bool = (v: unknown): boolean => v === 1 || v === 1n || v === true;
const dataO = (v: unknown): Date | null =>
  typeof v === "string" && v ? new Date(v) : v instanceof Date ? v : null;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export async function travasaTutto(d: Db): Promise<void> {
  const travasi = d.collection("travasi");
  const gia = await travasi.findOne({ _id: "sqlite:galdieri.db" as unknown as Document["_id"] });
  if (gia) return;

  if (!existsSync(PERCORSO_SQLITE)) {
    // Installazione nuova, senza SQLite da cui migrare: si semina il minimo che
    // serve, cioè le regole di default, se non ci sono già.
    const correnti = await d.collection<DocGen>("regole").findOne({ _id: "correnti" });
    if (!correnti) await scriviRegole(regoleDiDefault(), "iniziale");
    return;
  }

  const sql = new DatabaseSync(PERCORSO_SQLITE, { readOnly: true });
  try {
    let righe = 0;
    righe += await travasaDimensioni(d, sql);
    righe += await travasaRecensioni(d, sql);
    righe += await travasaRegole(d, sql);
    righe += await travasaEsecuzioni(d, sql);
    righe += await travasaTraduzioni(d, sql);
    righe += await travasaImpostazioni(d, sql);
    righe += await travasaStorici(d, sql);

    // Marcatori dei vecchi file JSON: bloccano la logica di default, che
    // altrimenti sovrascriverebbe le regole vere all'avvio.
    const ora = new Date();
    for (const f of MARCATORI_JSON) {
      await travasi.updateOne(
        { _id: f as unknown as Document["_id"] },
        { $setOnInsert: { eseguitoIl: ora, righe: 0, nota: "neutralizzato dal travaso SQLite" } },
        { upsert: true },
      );
    }
    await travasi.insertOne({
      _id: "sqlite:galdieri.db" as unknown as Document["_id"],
      eseguitoIl: ora,
      righe,
      nota: "travaso da data/galdieri.db",
    } as Document);
  } finally {
    sql.close();
  }
}

function tutte(sql: DatabaseSync, q: string): Record<string, unknown>[] {
  try {
    return sql.prepare(q).all() as Record<string, unknown>[];
  } catch {
    return [];
  }
}

async function scrivi(d: Db, nome: string, docs: Document[]): Promise<number> {
  if (docs.length === 0) return 0;
  const ops: AnyBulkWriteOperation<DocGen>[] = docs.map((doc) => {
    // L'_id sta nel filtro, non nel documento di sostituzione (il driver lo vieta).
    const { _id, ...resto } = doc;
    return { replaceOne: { filter: { _id }, replacement: resto, upsert: true } };
  });
  await d.collection<DocGen>(nome).bulkWrite(ops, { ordered: false });
  return docs.length;
}

async function travasaDimensioni(d: Db, sql: DatabaseSync): Promise<number> {
  let n = 0;

  n += await scrivi(
    d,
    "sedi",
    tutte(sql, "SELECT nome_normalizzato, nome, tag_freshdesk, creata_il FROM sedi").map((r) => ({
      _id: str(r.nome_normalizzato),
      nome: str(r.nome),
      tagFreshdesk: str(r.tag_freshdesk),
      creataIl: dataO(r.creata_il) ?? new Date("1970-01-01T00:00:00.000Z"),
    })),
  );

  n += await scrivi(
    d,
    "lingue",
    tutte(sql, "SELECT codice, nome, italiana FROM lingue").map((r) => ({
      _id: str(r.codice),
      nome: str(r.nome),
      italiana: bool(r.italiana),
    })),
  );

  n += await scrivi(
    d,
    "tipi_azione",
    tutte(sql, "SELECT tipo, servizio, titolo, scrittura FROM tipi_azione").map((r) => ({
      _id: str(r.tipo),
      servizio: str(r.servizio),
      titolo: str(r.titolo),
      scrittura: bool(r.scrittura),
    })),
  );

  n += await scrivi(
    d,
    "operatori",
    tutte(sql, "SELECT * FROM operatori").map((r) => ({
      _id: num(r.id),
      chiave: str(r.chiave),
      nome: str(r.nome),
      email: r.email ? str(r.email) : null,
      tipo: str(r.tipo),
      ruolo: str(r.ruolo),
      attivo: bool(r.attivo),
      diSistema: bool(r.di_sistema),
      creatoIl: dataO(r.creato_il) ?? new Date("1970-01-01T00:00:00.000Z"),
      disattivatoIl: dataO(r.disattivato_il),
    })),
  );

  n += await scrivi(
    d,
    "agenti_freshdesk",
    tutte(sql, "SELECT * FROM agenti_freshdesk").map((r) => ({
      _id: str(r.id_freshdesk),
      nome: str(r.nome),
      email: r.email ? str(r.email) : null,
      gruppo: str(r.gruppo),
      attivo: bool(r.attivo),
      operatoreId: r.operatore_id == null ? null : num(r.operatore_id),
      aggiornatoIl: dataO(r.aggiornato_il) ?? new Date(),
    })),
  );

  return n;
}

async function travasaRecensioni(d: Db, sql: DatabaseSync): Promise<number> {
  const righe = tutte(
    sql,
    `SELECT r.*, s.nome AS sede_nome, s.nome_normalizzato AS sede_chiave, s.tag_freshdesk AS sede_tag
       FROM recensioni r LEFT JOIN sedi s ON s.id = r.sede_id`,
  );
  return scrivi(
    d,
    "recensioni",
    righe.map((r) => ({
      _id: str(r.chiave),
      origine: str(r.origine) || "google",
      messaggioId: str(r.messaggio_id),
      oggetto: str(r.oggetto),
      etichettaId: r.etichetta_id ? str(r.etichetta_id) : null,
      nomeCliente: str(r.nome_cliente) || "(senza nome)",
      stelle: r.stelle == null ? null : num(r.stelle),
      punteggioTesto: str(r.punteggio_testo),
      testoOriginale: str(r.testo_originale),
      testoItaliano: r.testo_italiano == null ? null : str(r.testo_italiano),
      ingleseDiGoogle: str(r.inglese_di_google),
      giaItaliano: bool(r.gia_italiano),
      lingua: r.lingua_codice ? str(r.lingua_codice) : null,
      sede: {
        chiave: str(r.sede_chiave),
        nome: str(r.sede_nome) || "(sede non riconosciuta)",
        tagFreshdesk: str(r.sede_tag),
      },
      numeroMessaggi: num(r.numero_messaggi) || 1,
      haRisposta: bool(r.ha_risposta),
      risolto: bool(r.risolto),
      ricevutaIl: dataO(r.ricevuta_il) ?? new Date(),
      primaVistaIl: dataO(r.prima_vista_il) ?? new Date(),
      ultimaVistaIl: dataO(r.ultima_vista_il) ?? new Date(),
      rispostaRilevataIl: dataO(r.risposta_rilevata_il),
      risoltoRilevatoIl: dataO(r.risolto_rilevato_il),
      archiviataIl: dataO(r.archiviata_il),
      // Le colonne derivate erano GENERATED in SQLite: si copiano così com'erano,
      // niente ricalcolo che potrebbe divergere.
      ricevutaIlLocale: str(r.ricevuta_il_locale),
      annoMese: str(r.ricevuta_il_locale).slice(0, 7),
      dataLocale: str(r.ricevuta_il_locale).slice(0, 10),
      oraLocale: Number(str(r.ricevuta_il_locale).slice(11, 13)) || 0,
      settimanaIso: str(r.settimana_iso),
      giornoSettimana: num(r.giorno_settimana),
      haTesto: bool(r.ha_testo),
      archiviata: dataO(r.archiviata_il) != null,
      motivoArchiviazione: str(r.motivo_archiviazione),
      testoTroncato: bool(r.testo_troncato),
      impronta: r.impronta ? str(r.impronta) : null,
    })),
  );
}

async function travasaRegole(d: Db, sql: DatabaseSync): Promise<number> {
  // Stato corrente: ricostruito da regole + regole_stelle + azioni + parametri.
  const regole = tutte(sql, "SELECT * FROM regole ORDER BY ordine, id");
  const stelle = tutte(sql, "SELECT regola_id, stelle FROM regole_stelle ORDER BY regola_id, stelle");
  const azioni = tutte(sql, "SELECT * FROM azioni ORDER BY regola_id, ordine");
  const parametri = tutte(sql, "SELECT azione_id, nome, valore FROM azioni_parametri");

  const perAzione = new Map<number, Record<string, string>>();
  for (const p of parametri) {
    const m = perAzione.get(num(p.azione_id)) ?? {};
    m[str(p.nome)] = str(p.valore);
    perAzione.set(num(p.azione_id), m);
  }
  const stellePer = new Map<string, number[]>();
  for (const s of stelle) {
    const arr = stellePer.get(str(s.regola_id)) ?? [];
    arr.push(num(s.stelle));
    stellePer.set(str(s.regola_id), arr);
  }
  const azioniPer = new Map<string, Document[]>();
  for (const a of azioni) {
    const arr = azioniPer.get(str(a.regola_id)) ?? [];
    arr.push({ id: str(a.codice), tipo: str(a.tipo), parametri: perAzione.get(num(a.id)) ?? {} });
    azioniPer.set(str(a.regola_id), arr);
  }

  const correnti = regole.map((r) => ({
    id: str(r.id),
    nome: str(r.nome),
    attiva: bool(r.attiva),
    condizione: {
      stelle: stellePer.get(str(r.id)) ?? [],
      testo: str(r.condizione_testo) || "qualsiasi",
    },
    azioni: azioniPer.get(str(r.id)) ?? [],
  }));

  if (correnti.length > 0) {
    await d.collection<DocGen>("regole").replaceOne(
      { _id: "correnti" },
      { regole: correnti, aggiornateIl: new Date(), aggiornateDa: 1 },
      { upsert: true },
    );
  }

  // Storico delle versioni: copiato con impronta e sigillo.
  const versioni = tutte(sql, "SELECT * FROM regole_versioni ORDER BY id").map((v) => {
    const doc: Document = {
      _id: num(v.id),
      regolaId: str(v.regola_id),
      numero: num(v.numero),
      nome: str(v.nome),
      attiva: bool(v.attiva),
      condizione: JSON.parse(str(v.condizione) || "{}"),
      azioni: JSON.parse(str(v.azioni) || "[]"),
      impronta: str(v.impronta),
      tipoModifica: str(v.tipo_modifica) || "contenuto",
      origine: str(v.origine) || "interfaccia",
      nota: str(v.nota),
      creataIl: dataO(v.creata_il) ?? new Date(),
      creataDa: num(v.creata_da) || 1,
    };
    doc.sigillo = createHash("sha1").update(JSON.stringify(doc)).digest("hex");
    return doc;
  });
  const n = (await scrivi(d, "regole_versioni", versioni)) + (correnti.length > 0 ? 1 : 0);

  // Contatore, allineato al massimo id di versione già usato.
  const max = versioni.reduce((m, v) => Math.max(m, num(v._id)), 0);
  await d.collection<DocGen>("contatori").updateOne(
    { _id: "regole_versioni" },
    { $set: { valore: max } },
    { upsert: true },
  );

  return n;
}

async function travasaEsecuzioni(d: Db, sql: DatabaseSync): Promise<number> {
  const righe = tutte(sql, "SELECT * FROM esecuzioni");
  if (righe.length === 0) return 0;
  const nodi = tutte(sql, "SELECT * FROM esiti_nodi ORDER BY esecuzione_id, ordine");
  const scost = tutte(sql, "SELECT * FROM esecuzioni_scostamenti");

  const nodiPer = new Map<string, Document[]>();
  for (const n of nodi) {
    const arr = nodiPer.get(str(n.esecuzione_id)) ?? [];
    arr.push({
      azioneCodice: str(n.azione_codice),
      tipo: str(n.tipo),
      stato: str(n.stato),
      messaggio: str(n.messaggio),
      scrittura: false, // riempito sotto dal catalogo tipi_azione
      chiamata: n.chiamata_url
        ? { metodo: str(n.chiamata_metodo), url: str(n.chiamata_url), corpo: n.chiamata_corpo == null ? null : str(n.chiamata_corpo) }
        : null,
      durataMs: num(n.durata_ms),
    });
    nodiPer.set(str(n.esecuzione_id), arr);
  }
  const scostPer = new Map<string, Document[]>();
  for (const s of scost) {
    const arr = scostPer.get(str(s.esecuzione_id)) ?? [];
    arr.push({
      azioneCodice: str(s.azione_codice),
      parametro: str(s.parametro),
      valoreVersione: str(s.valore_versione),
      valoreUsato: str(s.valore_usato),
    });
    scostPer.set(str(s.esecuzione_id), arr);
  }

  // scrittura dei nodi dal catalogo
  const tipi = new Map<string, boolean>(
    tutte(sql, "SELECT tipo, scrittura FROM tipi_azione").map((t) => [str(t.tipo), bool(t.scrittura)]),
  );

  return scrivi(
    d,
    "esecuzioni",
    righe.map((r) => {
      const suoiNodi = (nodiPer.get(str(r.id)) ?? []).map((n) => ({
        ...n,
        scrittura: tipi.get(str(n.tipo)) ?? false,
      }));
      return {
        _id: str(r.id),
        quando: dataO(r.quando) ?? new Date(),
        modo: str(r.modo) === "reale" ? "reale" : "simulazione",
        esito: str(r.esito) === "errore" ? "errore" : "ok",
        regolaId: str(r.regola_id),
        regolaNome: str(r.regola_nome),
        regolaVersioneId: r.regola_versione_id == null ? null : num(r.regola_versione_id),
        operatoreId: num(r.operatore_id) || 1,
        recensioneChiave: str(r.recensione_chiave),
        recensioneNome: str(r.recensione_nome),
        recensioneStelle: r.recensione_stelle == null ? null : num(r.recensione_stelle),
        recensioneSede: str(r.recensione_sede),
        recensioneTesto: str(r.recensione_testo),
        testoModificato: bool(r.testo_modificato),
        durataMs: suoiNodi.reduce((s, n) => s + num((n as { durataMs?: unknown }).durataMs), 0),
        nodi: suoiNodi,
        scostamenti: scostPer.get(str(r.id)) ?? [],
        annullata: dataO(r.annullata_il) != null,
        annullataIl: dataO(r.annullata_il),
        archiviata: dataO(r.archiviata_il) != null,
        archiviataIl: dataO(r.archiviata_il),
      };
    }),
  );
}

async function travasaTraduzioni(d: Db, sql: DatabaseSync): Promise<number> {
  return scrivi(
    d,
    "traduzioni",
    tutte(sql, "SELECT * FROM traduzioni").map((r) => ({
      _id: str(r.chiave), // la chiave si COPIA, mai ricalcolata
      testoOriginale: str(r.testo_originale),
      italiano: str(r.italiano),
      linguaRilevata: r.lingua_rilevata ? str(r.lingua_rilevata) : null,
      creataIl: dataO(r.creata_il) ?? new Date(),
      usataIl: dataO(r.usata_il) ?? new Date(),
      usi: num(r.usi),
    })),
  );
}

async function travasaImpostazioni(d: Db, sql: DatabaseSync): Promise<number> {
  const valori = tutte(sql, "SELECT chiave, valore FROM impostazioni");
  const etichette = tutte(sql, "SELECT * FROM etichette ORDER BY ordine, id");
  await d.collection<DocGen>("impostazioni").replaceOne(
    { _id: "correnti" },
    {
      valori: valori.map((v) => ({
        chiave: str(v.chiave),
        valore: str(v.valore),
        aggiornataIl: new Date(),
        aggiornataDa: 1,
      })),
      etichette: etichette.map((e) => ({
        id: str(e.id),
        nome: str(e.nome),
        oggettoContiene: str(e.oggetto_contiene),
        mittenteContiene: str(e.mittente_contiene),
      })),
      aggiornateIl: new Date(),
    },
    { upsert: true },
  );
  return 1;
}

async function travasaStorici(d: Db, sql: DatabaseSync): Promise<number> {
  let n = 0;

  const storico = tutte(sql, "SELECT * FROM impostazioni_storico ORDER BY id").map((r) => {
    const doc: Document = {
      chiave: str(r.chiave),
      segreto: bool(r.segreto),
      quando: dataO(r.quando) ?? new Date(),
      operatoreId: num(r.operatore_id) || 1,
      azione: str(r.azione),
      valorePrecedente: r.valore_precedente == null ? null : str(r.valore_precedente),
      valoreNuovo: r.valore_nuovo == null ? null : str(r.valore_nuovo),
      presentePrima: bool(r.presente_prima),
      presenteDopo: bool(r.presente_dopo),
    };
    doc.sigillo = createHash("sha1").update(JSON.stringify(doc)).digest("hex");
    return doc;
  });
  if (storico.length > 0) {
    await d.collection("impostazioni_storico").insertMany(storico, { ordered: false });
    n += storico.length;
  }

  const attivita = tutte(sql, "SELECT * FROM registro_attivita ORDER BY id").map((r) => ({
    quando: dataO(r.quando) ?? new Date(),
    operatoreId: num(r.operatore_id) || 1,
    azione: str(r.azione),
    oggettoTipo: r.oggetto_tipo ? str(r.oggetto_tipo) : null,
    oggettoId: r.oggetto_id ? str(r.oggetto_id) : null,
    dettaglio: str(r.dettaglio),
  }));
  if (attivita.length > 0) {
    await d.collection("registro_attivita").insertMany(attivita as Document[], { ordered: false });
    n += attivita.length;
  }

  return n;
}

export async function riepilogoTravasi(d: Db) {
  const conta = (nome: string, filtro: Document = {}) => d.collection(nome).countDocuments(filtro);
  return {
    recensioni: await conta("recensioni"),
    versioni: await conta("regole_versioni"),
    esecuzioni: await conta("esecuzioni"),
    traduzioni: await conta("traduzioni"),
  };
}
