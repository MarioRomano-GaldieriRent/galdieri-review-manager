import { readFileSync } from "node:fs";
import path from "node:path";

// Anteprima regole per-utente (feature flag graduale).
//   npm run beta:utente                         → elenca gli utenti e le loro anteprime
//   npm run beta:utente -- <chiave|email> 1-2-stelle       → ACCENDE per quell'utente
//   npm run beta:utente -- <chiave|email> 1-2-stelle off   → SPEGNE
// Lo stesso si fa dall'interfaccia: Utenti → colonna «Anteprima 1-2★».

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

const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (metodo !== "GET") throw new Error(`SCRITTURA ESTERNA BLOCCATA: ${metodo}`);
  return fetchVero(input, init);
}) as typeof fetch;

async function main() {
  const { elencoUtenti, impostaRegolaBeta } = await import("@/server/auth/utenti");
  const utenti = await elencoUtenti();

  const identif = process.argv[2];
  const regolaId = process.argv[3];
  const spegni = process.argv[4]?.toLowerCase() === "off";

  if (!identif || !regolaId) {
    console.log("Utenti e anteprime attive:\n");
    for (const u of utenti) {
      const beta = (u.regoleBeta ?? []).join(", ") || "—";
      console.log(`  #${u._id}  ${u.chiave.padEnd(16)} ${u.ruolo.padEnd(11)} ${u.attivo ? "attivo " : "spento "}  anteprime: ${beta}   <${u.email ?? "-"}>`);
    }
    console.log("\nPer accendere:  npm run beta:utente -- <chiave|email> 1-2-stelle");
    process.exit(0);
  }

  const q = identif.toLowerCase();
  const u = utenti.find((x) => x.chiave.toLowerCase() === q || (x.email ?? "").toLowerCase() === q);
  if (!u) {
    console.error(`Nessun utente con chiave/email «${identif}». Esegui senza argomenti per l'elenco.`);
    process.exit(1);
  }

  await impostaRegolaBeta(u._id, regolaId, !spegni);
  console.log(`${spegni ? "SPENTA" : "ACCESA"} l'anteprima «${regolaId}» per ${u.chiave} (#${u._id}).`);
  const dopo = (await elencoUtenti()).find((x) => x._id === u._id);
  console.log(`Anteprime ora: ${(dopo?.regoleBeta ?? []).join(", ") || "—"}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
