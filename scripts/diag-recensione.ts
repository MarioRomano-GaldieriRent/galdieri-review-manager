import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA da Mongo: dump grezzo di una recensione d'archivio per nome.
//   npm run diag:recensione -- "paula"

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

async function main() {
  const cerca = (process.argv.slice(2).join(" ").trim() || "paula").toLowerCase();
  const { coll } = await import("@/server/db/connessione");
  const rec = await coll("recensioni");
  const docs = (await rec
    .find({ nomeCliente: { $regex: cerca, $options: "i" } })
    .limit(5)
    .toArray()) as Record<string, unknown>[];
  if (docs.length === 0) {
    console.log(`Nessuna recensione con nome ~ «${cerca}».`);
    process.exit(0);
  }
  for (const d of docs) {
    console.log("──────────");
    for (const k of ["_id", "nomeCliente", "stelle", "oggetto", "ricevutaIl", "idGoogle", "haRisposta", "risolto", "archiviata"]) {
      console.log(`  ${k}: ${JSON.stringify(d[k])}`);
    }
    const sede = d["sede"] as { nome?: string } | undefined;
    console.log(`  sede: ${JSON.stringify(sede?.nome ?? d["sede"])}`);
    const orig = String(d["originale"] ?? d["testo"] ?? "").slice(0, 160);
    console.log(`  testo: ${orig}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
