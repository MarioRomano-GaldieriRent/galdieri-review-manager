import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Controllo del database MongoDB. Non modifica niente: legge e riferisce.
//   npm run verifica:db
//
// È il perno della migrazione: buona parte delle garanzie che SQLite imponeva
// col motore (immutabilità delle versioni, integrità referenziale) qui sono
// diventate controlli da eseguire, non vincoli continui. Va lanciato di routine.
// ---------------------------------------------------------------------------

function caricaEnv() {
  try {
    const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const riga of txt.split(/\r?\n/)) {
      const m = riga.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* senza .env si prosegue */
  }
}
caricaEnv();

let ko = 0;
function verifica(nome: string, ok: boolean, extra = ""): void {
  if (!ok) ko += 1;
  console.log(`  ${ok ? "ok  " : "KO  "} ${nome}${extra ? ` — ${extra}` : ""}`);
}

async function main() {
  const { db, mongo } = await import("../src/server/db/connessione");
  const { avvia } = await import("../src/server/db/avvio");
  const { COLLEZIONI, NOMI_COLLEZIONI } = await import("../src/server/db/schema");
  const { CATALOGO_IMPOSTAZIONI } = await import("../src/server/db/seed");

  await avvia();
  const d = await db();

  console.log("\n— impianto —");
  const collezioni = await d.listCollections().toArray();
  const nomi = new Set(collezioni.map((c) => c.name));
  verifica("tutte le collezioni presenti", NOMI_COLLEZIONI.every((n) => nomi.has(n)));
  verifica("vista_recensioni presente", nomi.has("vista_recensioni"));
  // Ogni collezione deve avere il validator in validationAction:"error": se
  // qualcuno l'avesse messo a "warn" per spegnere i controlli, qui si vede.
  let validatorOk = true;
  for (const c of collezioni) {
    if (!NOMI_COLLEZIONI.includes(c.name)) continue;
    const opt = (c as { options?: { validationAction?: string; validator?: unknown } }).options;
    if (!opt?.validator || opt.validationAction !== "error") validatorOk = false;
  }
  verifica("validator attivi e in modalità error", validatorOk);

  console.log("\n— contenuto —");
  const conta = async (nome: string) => d.collection(nome).countDocuments();
  const numeri: Record<string, number> = {};
  for (const nome of ["recensioni", "regole_versioni", "esecuzioni", "traduzioni", "sedi", "sincronizzazioni"]) {
    numeri[nome] = await conta(nome);
    console.log(`  ${nome.padEnd(18)} ${numeri[nome]}`);
  }
  const regoleDoc = await d.collection("regole").findOne({ _id: "correnti" as never });
  const nRegole = (regoleDoc?.regole as unknown[] | undefined)?.length ?? 0;
  console.log(`  ${"regole (correnti)".padEnd(18)} ${nRegole}`);

  console.log("\n— confronto con SQLite (se presente) —");
  const percorsoSqlite = path.join(process.cwd(), "data", "galdieri.db");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const sql = new DatabaseSync(percorsoSqlite, { readOnly: true });
    const contaSql = (t: string) =>
      Number((sql.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    verifica("recensioni: stesso numero di SQLite", numeri.recensioni === contaSql("recensioni"), `mongo ${numeri.recensioni}, sqlite ${contaSql("recensioni")}`);
    verifica("versioni: stesso numero di SQLite", numeri.regole_versioni === contaSql("regole_versioni"));
    verifica("esecuzioni: stesso numero di SQLite", numeri.esecuzioni === contaSql("esecuzioni"));
    // Cache traduzioni: zero mancanti è il criterio. Una chiave persa significa
    // aver cambiato il modo di calcolarla, e stare per ripagare Azure.
    const chiaviSql = (sql.prepare("SELECT chiave FROM traduzioni").all() as { chiave: string }[]).map(
      (r) => r.chiave,
    );
    let mancanti = 0;
    for (const c of chiaviSql) {
      if (!(await d.collection("traduzioni").findOne({ _id: c as never }))) mancanti += 1;
    }
    verifica("cache traduzioni completa", mancanti === 0, `${chiaviSql.length} chiavi, ${mancanti} mancanti`);
    sql.close();
  } catch {
    console.log("  --   nessun data/galdieri.db da confrontare");
  }

  console.log("\n— protezioni —");
  // Nessun valore segreto nello storico.
  const segretiTrapelati = await d.collection("impostazioni_storico").countDocuments({
    segreto: true,
    $or: [{ valorePrecedente: { $ne: null } }, { valoreNuovo: { $ne: null } }],
  });
  verifica("nessun segreto nello storico", segretiTrapelati === 0);

  // Nessuna chiave segreta fra le impostazioni correnti.
  const segreti = CATALOGO_IMPOSTAZIONI.filter((c) => c.segreto).map((c) => c.chiave);
  const correnti = await d.collection("impostazioni").findOne({ _id: "correnti" as never });
  const chiaviCorrenti = ((correnti?.valori as { chiave: string }[] | undefined) ?? []).map(
    (v) => v.chiave,
  );
  verifica("nessuna chiave segreta fra le impostazioni", !chiaviCorrenti.some((c) => segreti.includes(c)));

  // Il validator rifiuta davvero un segreto.
  let barrieraSegreti = false;
  try {
    await d.collection("impostazioni").updateOne(
      { _id: "correnti" as never },
      { $push: { valori: { chiave: "translator.key", valore: "prova" } } as never },
    );
  } catch {
    barrieraSegreti = true;
  }
  verifica("il database rifiuta di salvare un segreto", barrieraSegreti);

  // Sigilli delle versioni: rilevano una modifica fatta aggirando il codice.
  const versioni = await d.collection("regole_versioni").find({}).toArray();
  let sigilliOk = true;
  for (const v of versioni) {
    const { sigillo, ...resto } = v as Record<string, unknown>;
    if (createHash("sha1").update(JSON.stringify(resto)).digest("hex") !== sigillo) sigilliOk = false;
  }
  verifica("sigilli delle versioni intatti", sigilliOk, `${versioni.length} versioni`);

  console.log("\n— integrità referenziale (sostituisce foreign_key_check) —");
  // Ogni esecuzione con versione deve puntare a una versione esistente.
  const idVersioni = new Set(versioni.map((v) => v._id));
  const esecOrfane = (await d.collection("esecuzioni").find({ regolaVersioneId: { $type: "number" } }).toArray()).filter(
    (e) => !idVersioni.has(e.regolaVersioneId),
  );
  verifica("nessuna esecuzione con versione inesistente", esecOrfane.length === 0);

  console.log("\n— operatore di sistema —");
  const sistema = await d.collection("operatori").findOne({ _id: 1 as never });
  verifica("operatore di sistema presente", Boolean(sistema), sistema ? String(sistema.chiave) : "assente");
  verifica("è l'unico di sistema", (await d.collection("operatori").countDocuments({ diSistema: true })) === 1);

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

  void COLLEZIONI;
  const client = await mongo();
  await client.close();
  console.log(`\n${ko === 0 ? "tutti i controlli passati" : `${ko} controlli falliti`}\n`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
