import { readFileSync } from "node:fs";
import path from "node:path";

// Dump di SOLA LETTURA delle regole correnti nel database, per vedere lo stato
// reale prima di qualunque modifica.  npm run diag:regole

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

// Guardia: qualsiasi scrittura esterna è bloccata (questo script solo legge).
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (metodo !== "GET") throw new Error(`SCRITTURA BLOCCATA: ${metodo}`);
  return fetchVero(input, init);
}) as typeof fetch;

async function main() {
  const { leggiRegole } = await import("@/server/db/regole");
  const regole = await leggiRegole();

  if (regole.length === 0) {
    console.log("Nessuna regola nel DB (regole/_id='correnti' vuoto): la home usa i default del codice.");
    process.exit(0);
  }

  console.log(`Regole nel DB: ${regole.length}\n`);
  for (const r of regole) {
    const stelle = r.condizione.stelle.join(",");
    console.log(`• [${r.attiva ? "ATTIVA " : "spenta "}] ${r.id}  «${r.nome}»`);
    console.log(`    condizione: stelle {${stelle}} · testo ${r.condizione.testo}`);
    console.log(`    automazione: ${r.automazione ? r.automazione.modo : "(assente → manuale)"}`);
    console.log(`    azioni: ${r.azioni.map((a) => a.tipo).join(" → ")}`);
    for (const a of r.azioni) {
      const p = Object.entries(a.parametri)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      console.log(`       - ${a.id} ${a.tipo}${p ? `  { ${p} }` : ""}`);
    }
    console.log("");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
