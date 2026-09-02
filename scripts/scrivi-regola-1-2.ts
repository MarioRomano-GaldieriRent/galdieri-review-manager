import { readFileSync } from "node:fs";
import path from "node:path";
import type { Regola } from "@/server/automation/types";

// Compila nel DB il flusso COMPLETO (due fasi) della regola «1 e 2 stelle».
// La regola resta SPENTA (attiva:false): non attiva niente, prepara solo il
// terreno. Storia immutabile preservata (scriviRegole registra una versione).
//
//   npm run scrivi:regola12            → DRY RUN (mostra cosa scriverebbe)
//   npm run scrivi:regola12 -- --scrivi → persiste davvero

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

// Nessuna scrittura ESTERNA: blocca ogni fetch non-GET (il DB non passa da fetch).
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (metodo !== "GET") throw new Error(`SCRITTURA ESTERNA BLOCCATA: ${metodo}`);
  return fetchVero(input, init);
}) as typeof fetch;

const CHERUBINA = "cherubina.panico@galdierirent.it";
const CUSTOMER_CARE = "customer.care@galdierirent.it";
const AGENTE_ESCALATION = "80128977810";
const TIPO_GMB = "Recensioni clienti GMB";

/** Il flusso completo, due fasi. attiva:false — NON si attiva ora. */
function regola12Completa(): Regola {
  return {
    id: "1-2-stelle",
    nome: "1 e 2 stelle — escalation",
    attiva: false,
    condizione: { stelle: [1, 2], testo: "qualsiasi" },
    azioni: [
      // --- Fase 1: presa in carico (parte subito) -----------------------
      {
        id: "e1",
        tipo: "email.inoltra",
        parametri: { a: CHERUBINA, cc: CUSTOMER_CARE, testo: "Si trasmette per quanto di competenza." },
      },
      { id: "e2", tipo: "freshdesk.trovaTicket", parametri: {} },
      // Classificazione alla presa in carico, come la sorella 3-stelle. Il
      // livello preciso «1 stella»/«2 stelle» oggi lo mette la chiusura reale
      // (chiudiTicketPubblicato → etichettaStelle); qui resta come intento.
      {
        id: "e6",
        tipo: "freshdesk.classifica",
        parametri: { tipo: TIPO_GMB, specifica1: "negativa", specifica2: "{stelle} stelle" },
      },
      { id: "e3", tipo: "freshdesk.tag", parametri: { tag: "{sede}" } },
      { id: "e4", tipo: "freshdesk.assegna", parametri: { agenteId: AGENTE_ESCALATION } },
      { id: "e5", tipo: "sistema.attendiRisposta", parametri: { da: CHERUBINA } },
      // --- Fase 2: flusso di ritorno (all'arrivo della risposta) ---------
      // Testo vuoto di proposito: lo scrive l'operatore con la risposta di
      // Cherubina. Mai un ringraziamento automatico su una recensione negativa.
      { id: "e7", tipo: "google.rispondi", parametri: { testo: "", testoInglese: "" } },
      { id: "e8", tipo: "freshdesk.stato", parametri: { stato: "4" } },
    ],
  };
}

function stampa(r: Regola) {
  console.log(`  [${r.attiva ? "ATTIVA" : "spenta"}] ${r.id} «${r.nome}» · stelle {${r.condizione.stelle.join(",")}}`);
  for (const a of r.azioni) {
    const p = Object.entries(a.parametri).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    console.log(`     - ${a.id} ${a.tipo}${p ? `  { ${p} }` : ""}`);
  }
}

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { leggiRegole, scriviRegole } = await import("@/server/db/regole");

  const correnti = await leggiRegole();
  if (correnti.length === 0) {
    console.error("DB senza regole (regole/correnti vuoto). Esegui prima npm run db:schema. Interrotto.");
    process.exit(1);
  }

  const nuova = regola12Completa();
  const trovata = correnti.some((r) => r.id === nuova.id);
  const nuove = trovata ? correnti.map((r) => (r.id === nuova.id ? nuova : r)) : [...correnti, nuova];

  const vecchia = correnti.find((r) => r.id === nuova.id);
  console.log(vecchia ? "PRIMA (nel DB):" : "PRIMA: (regola 1-2-stelle assente nel DB)");
  if (vecchia) stampa(vecchia);
  console.log("\nDOPO (cosa scriverei):");
  stampa(nuova);
  console.log(`\nAltre regole toccate: nessuna (${nuove.length - 1} restano identiche).`);

  if (!scrivi) {
    console.log("\n[DRY RUN] Niente scritto. Riesegui con  -- --scrivi  per persistere.");
    process.exit(0);
  }

  await scriviRegole(nuove, "importazione", "Flusso completo 1-2 stelle (due fasi), lasciato SPENTO");
  console.log("\n✅ Scritto nel DB. La regola resta SPENTA. Storia versioni aggiornata.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
