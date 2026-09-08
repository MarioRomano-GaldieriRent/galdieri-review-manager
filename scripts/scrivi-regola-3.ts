import { readFileSync } from "node:fs";
import path from "node:path";
import type { Regola } from "@/server/automation/types";

// Compila nel DB la regola «3 stelle» nella forma IBRIDA decisa con Mario l'8
// settembre 2026: la card offre sia «Rispondi» (testo preimpostato, o proposta
// AI se c'è un commento) sia «Inoltra al customer care». Qui c'è SOLO il ramo
// della risposta diretta — stessa forma delle 5★ senza testo, perché è la
// risposta all'email che apre il ticket. L'inoltro è un'azione a parte
// (src/app/dashboard/inoltro.ts) e prende la Fase 1 dalla regola 1-2★.
//
// Perché «Grazie.»: nelle email inviate degli ultimi 12 mesi le 3★ sono 37 —
// 26 scritte dal customer care, 11 da Stefania, e di queste 6 sono un semplice
// «Grazie.»/«Thank you.» (le 3★ senza commento). Con un commento interviene la
// proposta AI, tarata sulle sue risposte vere.
//
// La regola resta SPENTA (attiva:false): si accende da Impostazioni. La storia
// resta immutabile (scriviRegole registra una versione).
//
//   npm run scrivi:regola3            → DRY RUN (mostra cosa scriverebbe)
//   npm run scrivi:regola3 -- --scrivi → persiste davvero

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

function regola3Ibrida(marketing: string, tipoGmb: string): Regola {
  return {
    id: "3-stelle",
    nome: "3 stelle — risposta o inoltro",
    attiva: false,
    condizione: { stelle: [3], testo: "qualsiasi" },
    azioni: [
      // La risposta all'email è ciò che APRE il ticket (come per le 5★ senza
      // testo): va prima dei nodi Freshdesk. Il testo del box — «Grazie.» o la
      // proposta AI — arriva qui e su Google insieme (nodiRisposta).
      { id: "f1", tipo: "email.rispondi", parametri: { a: "", testo: "Grazie.", testoInglese: "Thank you." } },
      { id: "f2", tipo: "freshdesk.trovaTicket", parametri: {} },
      // «negativa» è come le 3★ sono sempre state classificate su Freshdesk
      // (regola precedente e ticket reali): non si cambia il significato del
      // campo per il fatto che stavolta risponde Stefania.
      {
        id: "f3",
        tipo: "freshdesk.classifica",
        parametri: { tipo: tipoGmb, specifica1: "negativa", specifica2: "3 stelle" },
      },
      { id: "f4", tipo: "freshdesk.tag", parametri: { tag: "{sede}" } },
      // Risponde Stefania → il ticket è dell'Ufficio Marketing, come le 4-5★.
      // Se invece la inoltra, è l'azione d'inoltro ad assegnarlo a Cherubina.
      { id: "f5", tipo: "freshdesk.assegna", parametri: { agenteId: marketing } },
      { id: "f6", tipo: "google.rispondi", parametri: { testo: "Grazie.", testoInglese: "Thank you." } },
      { id: "f7", tipo: "freshdesk.stato", parametri: { stato: "4" } },
    ],
  };
}

function stampa(r: Regola) {
  console.log(`  [${r.attiva ? "ATTIVA" : "spenta"}] ${r.id} «${r.nome}» · stelle {${r.condizione.stelle.join(",")}} · testo ${r.condizione.testo}`);
  for (const a of r.azioni) {
    const p = Object.entries(a.parametri).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    console.log(`     - ${a.id} ${a.tipo}${p ? `  { ${p} }` : ""}`);
  }
}

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { leggiRegole, scriviRegole } = await import("@/server/db/regole");
  const { AGENTE_MARKETING, TIPO_TICKET_GMB } = await import("@/server/automation/rules");

  const correnti = await leggiRegole();
  if (correnti.length === 0) {
    console.error("DB senza regole (regole/correnti vuoto). Esegui prima npm run db:schema. Interrotto.");
    process.exit(1);
  }

  const nuova = regola3Ibrida(AGENTE_MARKETING, TIPO_TICKET_GMB);
  const vecchia = correnti.find((r) => r.id === nuova.id);
  const nuove = vecchia ? correnti.map((r) => (r.id === nuova.id ? nuova : r)) : [...correnti, nuova];

  console.log(vecchia ? "PRIMA (nel DB):" : "PRIMA: (regola 3-stelle assente nel DB)");
  if (vecchia) stampa(vecchia);
  console.log("\nDOPO (cosa scriverei):");
  stampa(nuova);
  console.log(`\nAltre regole toccate: nessuna (${nuove.length - 1} restano identiche).`);

  if (!scrivi) {
    console.log("\n[DRY RUN] Niente scritto. Riesegui con  -- --scrivi  per persistere.");
    process.exit(0);
  }

  await scriviRegole(nuove, "importazione", "3 stelle ibrida: risposta diretta (Grazie./AI) + inoltro al customer care; lasciata SPENTA");
  console.log("\n✅ Scritto nel DB. La regola resta SPENTA: si accende da Impostazioni. Storia versioni aggiornata.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
