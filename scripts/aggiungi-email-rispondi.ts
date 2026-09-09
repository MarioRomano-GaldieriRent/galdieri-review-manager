import { readFileSync } from "node:fs";
import path from "node:path";
import type { Azione, Regola } from "@/server/automation/types";

// Aggiunge il nodo «Rispondi all'email» alle regole che ne sono prive.
//
// PERCHÉ. È la risposta all'email della recensione (verso customer.care, che
// segue il Reply-To) a far NASCERE il ticket su Freshdesk: nei dati reali il
// «Ticket Creato» arriva circa sei secondi dopo. Le regole 5-stelle-senza-testo
// e 3-stelle quel nodo ce l'hanno; 4-stelle e 5-stelle-con-testo no — e senza
// di lui nessuna email parte, nessun ticket nasce, e i nodi Freshdesk che
// seguono si saltano tutti perché non hanno un bersaglio.
//
// Caso reale che l'ha fatto emergere (9/9/2026): Vanessa CREPEAUX, 4★ a Palermo
// Punta Raisi, pubblicata su Google alle 12:49 — nessun ticket, e classifica,
// tag e assegnazione tutti «saltati».
//
// Il nodo va PRIMA di quelli Freshdesk (è lui a creare il bersaglio) e porta lo
// stesso testo del nodo Google della sua regola, così senza riscrittura email e
// risposta pubblica dicono la stessa cosa. Quando invece l'operatore riscrive il
// testo nel riquadro, la riscrittura si applica a TUTTI i nodi di risposta
// (nodiRisposta in rules.ts): email e Google restano allineate da sole.
//
//   npm run aggiungi:emailrispondi             → DRY RUN
//   npm run aggiungi:emailrispondi -- --scrivi → persiste

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

/** Le regole da sistemare, con l'id da dare al nodo nuovo. */
const DA_SISTEMARE: Record<string, string> = {
  "4-stelle": "c0",
  "5-stelle-con-testo": "b0",
};

function conEmailRispondi(r: Regola, idNodo: string): { regola: Regola; nota: string } {
  if (r.azioni.some((a) => a.tipo === "email.rispondi")) {
    return { regola: r, nota: "ha già il nodo: lasciata com'è" };
  }
  const google = r.azioni.find((a) => a.tipo === "google.rispondi");
  if (!google) {
    return { regola: r, nota: "NON ha un nodo google.rispondi: non so che testo mettere, lasciata com'è" };
  }
  const nodo: Azione = {
    id: idNodo,
    tipo: "email.rispondi",
    parametri: {
      // Vuoto: segue il Reply-To dell'email, che Zapier imposta già a
      // customer.care@galdierirent.it — ed è quella casella a creare il ticket.
      a: "",
      testo: google.parametri.testo ?? "",
      testoInglese: google.parametri.testoInglese ?? "",
    },
  };
  return { regola: { ...r, azioni: [nodo, ...r.azioni] }, nota: `nodo ${idNodo} aggiunto in testa` };
}

function stampa(r: Regola) {
  console.log(`  [${r.attiva ? "ATTIVA" : "spenta"}] ${r.id} «${r.nome}»`);
  for (const a of r.azioni) {
    const p = Object.entries(a.parametri)
      .map(([k, v]) => `${k}=${JSON.stringify(String(v).slice(0, 60))}`)
      .join(", ");
    console.log(`     - ${a.id} ${a.tipo}${p ? `  { ${p} }` : ""}`);
  }
}

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { leggiRegole, scriviRegole } = await import("@/server/db/regole");

  const correnti = await leggiRegole();
  if (correnti.length === 0) {
    console.error("DB senza regole. Esegui prima npm run db:schema. Interrotto.");
    process.exit(1);
  }

  const nuove: Regola[] = [];
  let cambiate = 0;
  for (const r of correnti) {
    const idNodo = DA_SISTEMARE[r.id];
    if (!idNodo) {
      nuove.push(r);
      continue;
    }
    const { regola, nota } = conEmailRispondi(r, idNodo);
    console.log(`\n${r.id}: ${nota}`);
    if (regola !== r) {
      cambiate++;
      console.log("  PRIMA:");
      stampa(r);
      console.log("  DOPO:");
      stampa(regola);
    }
    nuove.push(regola);
  }

  console.log(`\nRegole modificate: ${cambiate} · invariate: ${correnti.length - cambiate}`);
  if (cambiate === 0) {
    console.log("Niente da fare.");
    process.exit(0);
  }
  if (!scrivi) {
    console.log("\n[DRY RUN] Niente scritto. Riesegui con  -- --scrivi  per persistere.");
    process.exit(0);
  }

  await scriviRegole(
    nuove,
    "importazione",
    "Aggiunto email.rispondi a 4-stelle e 5-stelle-con-testo: senza di lui non nasceva il ticket Freshdesk",
  );
  console.log("\n✅ Scritto nel DB. Lo stato acceso/spento delle regole non è stato toccato.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
