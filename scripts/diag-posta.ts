import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA: cerca nella Posta in arrivo di UNA casella specifica i messaggi
// che contengono un termine (ricerca mirata, non sfoglia tutta la posta). Serve
// a verificare se una notifica Freshdesk è arrivata.
//   npm run diag:posta -- stefania.maffeo@galdierirent.it 59332
//   npm run diag:posta -- stefania.maffeo@galdierirent.it risolto

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

// Solo GET verso Graph (più il token). Nessuna scrittura/modifica.
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
  const metodo = (init?.method ?? "GET").toUpperCase();
  const soloToken = /login\.microsoftonline\.com/.test(url);
  if (metodo !== "GET" && !soloToken) throw new Error(`SCRITTURA BLOCCATA: ${metodo} ${url}`);
  return fetchVero(input, init);
}) as typeof fetch;

async function main() {
  const mailbox = process.argv.find((a) => a.includes("@"));
  const termine = process.argv.slice(2).find((a) => !a.includes("@"));
  if (!mailbox || !termine) {
    console.error("Uso: npm run diag:posta -- <casella@dominio> <termine>");
    process.exit(1);
  }
  const { listInbox } = await import("@/server/graph/client");

  console.log(`Cerco «${termine}» in ${mailbox} (solo Posta in arrivo)…\n`);
  let res;
  try {
    res = await listInbox({ mailbox, search: termine, top: 30 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`ACCESSO NON RIUSCITO: ${msg}`);
    if (/403|Access|Denied|ApplicationAccessPolicy/i.test(msg)) {
      console.error("→ Il token app-only NON ha accesso a questa casella (permesso ristretto). Non posso leggerla da qui.");
    }
    process.exit(1);
  }

  console.log(`Trovati ${res.messages.length} messaggi:\n`);
  for (const m of res.messages) {
    console.log(`  • ${m.receivedDateTime}  da: ${m.fromName} <${m.fromAddress}>`);
    console.log(`    oggetto: ${m.subject}`);
    console.log(`    ${m.preview.slice(0, 140)}`);
    console.log("");
  }
  if (res.messages.length === 0) console.log("  (nessun messaggio contiene quel termine)");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
