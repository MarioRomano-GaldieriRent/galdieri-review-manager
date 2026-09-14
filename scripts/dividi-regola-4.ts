import { readFileSync } from "node:fs";
import path from "node:path";
import type { Regola } from "@/server/automation/types";

// Divide la regola «4 stelle» in due, come già le 5 stelle (decisione di Mario,
// 14/9/2026):
//
//  4-stelle-senza-testo  (NUOVA) → «Grazie.» / «Thank you.», come le 5★ senza
//                                  testo: non c'è nulla nel merito a cui
//                                  replicare. Lingua decisa dal NOME, come là.
//  4-stelle              (resta) → solo CON testo: nel box la proposta dell'AI,
//                                  col testo della regola come ripiego.
//
// Prima una sola regola «4 stelle» con testo «qualsiasi» copriva entrambi i
// casi, e su una 4★ senza commento proponeva «Grazie {nome} per la recensione.
// Siamo a disposizione per rendere il prossimo noleggio ancora migliore…» —
// una risposta costruita per un commento che non c'è.
//
// L'id «4-stelle» NON cambia: le esecuzioni già registrate e le versioni
// della regola vi puntano, e rinominarlo spezzerebbe lo storico. Cambiano
// solo il nome («4 stelle con testo») e la condizione (testo «con»).
// La nuova nasce ACCESA: la vecchia lo è, e oggi copre anche le 4★ senza
// testo — spegnerla le farebbe sparire dalla coda.
//
// Foto: dall'email di Zapier non si capisce se la recensione ha foto, quindi
// «senza testo» vuol dire senza commento — come per le 5★.
//
//   npx tsx --tsconfig tsconfig.json scripts/dividi-regola-4.ts            → PROVA
//   npx tsx --tsconfig tsconfig.json scripts/dividi-regola-4.ts --scrivi   → scrive

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

// Nessuna scrittura ESTERNA: si tocca solo il database.
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (metodo !== "GET") throw new Error(`SCRITTURA ESTERNA BLOCCATA: ${metodo}`);
  return fetchVero(input, init);
}) as typeof fetch;

function stampa(r: Regola) {
  console.log(
    `  [${r.attiva ? "ATTIVA" : "spenta"}] ${r.id} «${r.nome}» · stelle {${r.condizione.stelle.join(",")}} · testo ${r.condizione.testo}`,
  );
  for (const a of r.azioni) {
    const p = Object.entries(a.parametri)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    console.log(`     - ${a.id} ${a.tipo}${p ? `  { ${p} }` : ""}`);
  }
}

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { leggiRegole, scriviRegole } = await import("@/server/db/regole");
  const { regola4SenzaTesto } = await import("@/server/automation/rules");

  const correnti = await leggiRegole();
  const vecchia = correnti.find((r) => r.id === "4-stelle");
  if (!vecchia) {
    console.error("Regola «4-stelle» assente nel DB: niente da dividere. Interrotto.");
    process.exit(1);
  }
  if (correnti.some((r) => r.id === "4-stelle-senza-testo")) {
    console.log("La regola «4-stelle-senza-testo» esiste già: divisione già fatta, niente da scrivere.");
    process.exit(0);
  }

  // Prende agente e tipo ticket DALLA regola corrente, non dai default: se in
  // Impostazioni sono stati cambiati, la nuova regola deve dire la stessa cosa.
  const agente = vecchia.azioni.find((a) => a.tipo === "freshdesk.assegna")?.parametri.agenteId;
  const tipo = vecchia.azioni.find((a) => a.tipo === "freshdesk.classifica")?.parametri.tipo;
  if (!agente || !tipo) {
    console.error("Nella regola «4-stelle» mancano assegnazione o classificazione: controlla a mano. Interrotto.");
    process.exit(1);
  }

  const conTesto: Regola = {
    ...vecchia,
    nome: "4 stelle con testo",
    condizione: { ...vecchia.condizione, stelle: [4], testo: "con" },
  };
  const senzaTesto: Regola = { ...regola4SenzaTesto(agente, tipo), attiva: vecchia.attiva };

  // La nuova subito prima della sua gemella, così in Impostazioni stanno vicine.
  const nuove: Regola[] = [];
  for (const r of correnti) {
    if (r.id === "4-stelle") nuove.push(senzaTesto, conTesto);
    else nuove.push(r);
  }

  console.log("PRIMA (nel DB):");
  stampa(vecchia);
  console.log("\nDOPO:");
  stampa(senzaTesto);
  stampa(conTesto);
  console.log(`\nAltre regole: identiche (${correnti.length - 1}).`);

  if (!scrivi) {
    console.log("\n[PROVA] Niente scritto. Rilancia con --scrivi.");
    process.exit(0);
  }

  await scriviRegole(
    nuove,
    "importazione",
    "4 stelle divisa: senza testo → Grazie./Thank you. (come le 5★); con testo → proposta AI",
  );
  console.log("\n✅ Scritto. Storia versioni aggiornata.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
