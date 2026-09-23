import { readFileSync } from "node:fs";
import path from "node:path";

// Scrive `origineInoltro` sulle escalation che non ce l'hanno (pilota / portale
// / posta): è il campo che «In attesa» usa per dire chi ha inoltrato.
//
// Come si decide, in ordine:
//   1. il registro attività ha un «pilota.inoltrata» per quella recensione
//      → pilota (è l'unica prova certa: il pilota inoltra a nome del Sistema,
//        ma a nome del Sistema è registrata anche la ricostruzione dalla posta);
//   2. operatore ≠ Sistema → portale (l'ha premuto una persona);
//   3. altrimenti → posta (inoltro partito da Outlook e ricostruito da noi).
//
// Si può rilanciare quante volte si vuole: tocca solo i documenti senza il
// campo, quindi non riscrive mai una decisione già presa dal codice nuovo.
// Va rilanciato DOPO l'aggiornamento del server, per marcare gli inoltri che il
// pilota ha fatto con la versione precedente.
//
//   npm run origine:inoltri            → PROVA, non scrive
//   npm run origine:inoltri -- --scrivi

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { coll } = await import("@/server/db/connessione");
  const { OPERATORE_SISTEMA } = await import("@/server/db/attivita");
  type Doc = {
    _id: string;
    operatoreId: number;
    stato: string;
    origineInoltro?: string;
    nomeCliente: string;
  };

  const esc = await coll<Doc>("escalation");
  const registro = await coll<{ azione: string; oggettoId: string | null }>("registro_attivita");

  const daPilota = new Set(
    (
      await registro
        .find({ azione: "pilota.inoltrata" }, { projection: { oggettoId: 1 } })
        .toArray()
    )
      .map((a) => a.oggettoId)
      .filter((x): x is string => typeof x === "string"),
  );
  const senza = await esc.find({ origineInoltro: { $exists: false } }).toArray();

  const conta = { pilota: 0, portale: 0, posta: 0 };
  for (const d of senza) {
    const origine = daPilota.has(d._id)
      ? "pilota"
      : d.operatoreId !== OPERATORE_SISTEMA
        ? "portale"
        : "posta";
    conta[origine as keyof typeof conta]++;
    if (origine === "pilota") console.log(`  pilota: «${d.nomeCliente}» (${d.stato})`);
    if (scrivi) await esc.updateOne({ _id: d._id }, { $set: { origineInoltro: origine } });
  }

  const gia = await esc.countDocuments({ origineInoltro: { $exists: true } });
  console.log(
    `\nSenza campo: ${senza.length} → pilota ${conta.pilota}, portale ${conta.portale}, posta ${conta.posta}. Già a posto: ${gia}.`,
  );
  console.log(scrivi ? "✅ Scritto." : "[PROVA] Niente scritto. Rilancia con --scrivi.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
