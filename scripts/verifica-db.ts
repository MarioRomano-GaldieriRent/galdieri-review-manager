import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Controllo del database locale. Non modifica niente: apre, interroga e
// riferisce. Da lanciare con:  npm run verifica:db
//
// Serve a rispondere a una domanda sola: dopo il passaggio dai file JSON al
// database, i dati sono ancora tutti lì e le protezioni funzionano davvero?
// ---------------------------------------------------------------------------

function caricaEnv() {
  try {
    const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const riga of txt.split(/\r?\n/)) {
      const m = riga.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* senza .env si prosegue: qui non si chiama nessun servizio esterno */
  }
}
caricaEnv();

let passati = 0;
let falliti = 0;

function verifica(nome: string, condizione: boolean, dettaglio = ""): void {
  if (condizione) {
    passati += 1;
    console.log(`  ok    ${nome}${dettaglio ? ` — ${dettaglio}` : ""}`);
  } else {
    falliti += 1;
    console.log(`  KO    ${nome}${dettaglio ? ` — ${dettaglio}` : ""}`);
  }
}

async function main() {
  const { db, chiudiDb, conta, tutteLeRighe, unaRiga } = await import("../src/server/db/connessione");
  const { VERSIONE_SCHEMA } = await import("../src/server/db/schema");
  await import("../src/server/db/avvio");

  const c = db();

  console.log("\n— impianto —");
  // I PRAGMA non restituiscono sempre una colonna che si chiama come loro:
  // `PRAGMA busy_timeout` risponde in una colonna di nome "timeout". Si legge
  // il primo valore della riga, qualunque nome abbia.
  const pragma = (nome: string) => {
    const riga = c.prepare(`PRAGMA ${nome}`).get() as Record<string, unknown> | undefined;
    return riga ? Object.values(riga)[0] : undefined;
  };
  verifica("versione schema", pragma("user_version") === VERSIONE_SCHEMA, `user_version=${pragma("user_version")}`);
  // È il controllo che intercetta la trappola dell'opzione { timeout } del
  // costruttore, che i tipi accettano ma Node ignora in silenzio.
  verifica("attesa su file occupato", pragma("busy_timeout") === 5000, `busy_timeout=${pragma("busy_timeout")}`);
  verifica("journal WAL", String(pragma("journal_mode")).toLowerCase() === "wal");
  verifica("chiavi esterne attive", pragma("foreign_keys") === 1);
  verifica("integrità", (c.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok");
  verifica("nessuna chiave esterna rotta", c.prepare("PRAGMA foreign_key_check").all().length === 0);

  console.log("\n— contenuto —");
  const numeri = {
    recensioni: conta("SELECT COUNT(*) FROM recensioni"),
    regole: conta("SELECT COUNT(*) FROM regole"),
    versioni: conta("SELECT COUNT(*) FROM regole_versioni"),
    azioni: conta("SELECT COUNT(*) FROM azioni"),
    parametri: conta("SELECT COUNT(*) FROM azioni_parametri"),
    esecuzioni: conta("SELECT COUNT(*) FROM esecuzioni"),
    nodi: conta("SELECT COUNT(*) FROM esiti_nodi"),
    traduzioni: conta("SELECT COUNT(*) FROM traduzioni"),
    sedi: conta("SELECT COUNT(*) FROM sedi"),
    sincronizzazioni: conta("SELECT COUNT(*) FROM sincronizzazioni"),
  };
  for (const [k, v] of Object.entries(numeri)) console.log(`  ${k.padEnd(18)} ${v}`);

  console.log("\n— confronto con i file di partenza —");
  const dati = path.join(process.cwd(), "data");
  const migrato = (nome: string) => path.join(dati, `${nome}.migrato`);

  if (existsSync(migrato("automation-runs.json"))) {
    const runs = JSON.parse(readFileSync(migrato("automation-runs.json"), "utf8")) as unknown[];
    verifica("esecuzioni importate tutte", numeri.esecuzioni >= runs.length, `${numeri.esecuzioni} nel db, ${runs.length} nel file`);
  } else {
    console.log("  --    nessun automation-runs.json.migrato da confrontare");
  }

  if (existsSync(migrato("translations.json"))) {
    const cache = JSON.parse(readFileSync(migrato("translations.json"), "utf8")) as Record<string, unknown>;
    const chiavi = Object.keys(cache);
    // Il criterio è zero mancanti: una sola chiave persa significa aver
    // cambiato il modo di calcolarla, e quindi stare per ripagare Azure.
    const mancanti = chiavi.filter(
      (k) => !unaRiga("SELECT chiave FROM traduzioni WHERE chiave = ?", k),
    );
    verifica("cache traduzioni completa", mancanti.length === 0, `${chiavi.length} chiavi, ${mancanti.length} mancanti`);
  } else {
    console.log("  --    nessun translations.json.migrato da confrontare");
  }

  console.log("\n— ordini semantici —");
  const azioniFuoriPosto = tutteLeRighe<{ regola_id: string }>(
    `SELECT regola_id FROM (
       SELECT regola_id, ordine, ROW_NUMBER() OVER (PARTITION BY regola_id ORDER BY ordine) - 1 AS atteso
         FROM azioni)
      WHERE ordine <> atteso`,
  );
  verifica("sequenza dei nodi senza buchi", azioniFuoriPosto.length === 0);
  const ordiniRegole = tutteLeRighe<{ ordine: number }>("SELECT ordine FROM regole ORDER BY ordine");
  verifica(
    "ordine delle regole senza duplicati",
    new Set(ordiniRegole.map((r) => r.ordine)).size === ordiniRegole.length,
  );

  console.log("\n— protezioni —");
  // Nessun valore segreto deve essere finito nello storico. Se questo conteggio
  // fosse diverso da zero il database andrebbe considerato compromesso.
  verifica(
    "nessun segreto nello storico",
    conta(
      `SELECT COUNT(*) FROM impostazioni_storico
        WHERE segreto = 1 AND (valore_precedente IS NOT NULL OR valore_nuovo IS NOT NULL)`,
    ) === 0,
  );
  verifica(
    "nessuna chiave segreta fra le impostazioni",
    conta(
      `SELECT COUNT(*) FROM impostazioni i
        JOIN impostazioni_catalogo c ON c.chiave = i.chiave WHERE c.segreto = 1`,
    ) === 0,
  );

  let barrieraSegreti = false;
  try {
    c.prepare("INSERT INTO impostazioni (chiave, valore, aggiornata_il) VALUES (?,?,?)").run(
      "translator.key",
      "prova",
      new Date().toISOString(),
    );
  } catch {
    barrieraSegreti = true;
  }
  verifica("il database rifiuta di salvare un segreto", barrieraSegreti);

  let barrieraVersioni = false;
  const primaVersione = unaRiga<{ id: number }>("SELECT id FROM regole_versioni LIMIT 1");
  if (primaVersione) {
    try {
      c.prepare("UPDATE regole_versioni SET nome = 'modificato' WHERE id = ?").run(primaVersione.id);
    } catch {
      barrieraVersioni = true;
    }
  }
  verifica("una versione di regola non si può modificare", barrieraVersioni || !primaVersione);

  console.log("\n— impostazioni: la precedenza al .env regge ancora —");
  const { loadSettings, resolveGraph, resolveFreshdesk, resolveTranslator, isSet } = await import(
    "../src/server/settings"
  );
  const s = await loadSettings();
  const [g, f, t] = [await resolveGraph(s), await resolveFreshdesk(s), await resolveTranslator(s)];
  verifica("modalità in simulazione", s.modo === "simulazione", s.modo);
  verifica("almeno un'etichetta", s.labels.length > 0, `${s.labels.length}`);
  verifica("client secret Microsoft rilevato", isSet(g.clientSecret));
  verifica("API key Freshdesk rilevata", isSet(f.apiKey));
  verifica("chiave Azure rilevata", isSet(t.key));

  console.log("\n— piani di esecuzione —");
  const piano = tutteLeRighe<{ detail: string }>(
    "EXPLAIN QUERY PLAN SELECT * FROM recensioni WHERE archiviata_il IS NULL ORDER BY ricevuta_il_locale DESC LIMIT 50",
  );
  verifica(
    "la coda usa un indice",
    piano.some((p) => /USING INDEX/i.test(p.detail)),
    piano.map((p) => p.detail).join(" | "),
  );

  chiudiDb();
  console.log(`\n${passati} controlli passati, ${falliti} falliti\n`);
  process.exit(falliti === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
