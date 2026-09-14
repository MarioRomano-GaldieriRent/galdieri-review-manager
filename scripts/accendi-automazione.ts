import { readFileSync } from "node:fs";
import path from "node:path";
import type { Automazione } from "@/server/automation/types";

// Mette in AUTOMATICO le regole «5 stelle senza testo» e «4 stelle senza testo»
// (decisione di Mario, 14/9/2026):
//
//   dal lunedì al venerdì, dalle 9:00 alle 18:00, pausa dalle 13:00 alle 14:00,
//   15 minuti dopo l'arrivo della recensione.
//
// La pausa è 13→14: la richiesta diceva «dalle 13 fino alle 12», e 13-14 è la
// stessa pausa che il customer care dichiara nelle sue risposte automatiche
// («dalle 9:00 alle 13:00 e dalle 14:00 alle 18:00»).
//
// Scrivere qui NON fa partire niente da solo: il pilota gira solo sul server che
// ha AUTOPILOTA=1 nel .env e il codice nuovo. Una volta acceso lavora TUTTE le
// recensioni della regola ancora da rispondere, arretrato compreso.
//
//   npx tsx --tsconfig tsconfig.json scripts/accendi-automazione.ts            → PROVA
//   npx tsx --tsconfig tsconfig.json scripts/accendi-automazione.ts --scrivi   → scrive
//   npx tsx --tsconfig tsconfig.json scripts/accendi-automazione.ts --spegni   → torna manuale

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

const REGOLE = ["5-stelle-senza-testo", "4-stelle-senza-testo"];

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const spegni = process.argv.includes("--spegni");
  const { leggiRegole, scriviRegole } = await import("@/server/db/regole");
  const { regolaAutomatizzabile, automazioneDi } = await import("@/server/automation/types");

  const correnti = await leggiRegole();
  const ora = new Date().toISOString();
  const nuove = correnti.map((r) => {
    if (!REGOLE.includes(r.id)) return r;
    const automazione: Automazione = spegni
      ? { ...automazioneDi(r), modo: "manuale", attivaDal: null }
      : {
          modo: "programmato",
          giorni: [1, 2, 3, 4, 5],
          daOra: 9,
          aOra: 18,
          pausa: { daOra: 13, aOra: 14 },
          ritardoMinuti: 15,
          // Riaccendendo una regola già automatica si conserva la data vecchia.
          attivaDal: r.automazione?.modo && r.automazione.modo !== "manuale" && r.automazione.attivaDal
            ? r.automazione.attivaDal
            : ora,
        };
    return { ...r, automazione };
  });

  for (const id of REGOLE) {
    const r = nuove.find((x) => x.id === id);
    if (!r) {
      console.error(`Regola «${id}» assente nel DB. Interrotto.`);
      process.exit(1);
    }
    if (!regolaAutomatizzabile(r)) {
      console.error(`Regola «${id}» non automatizzabile (serve «senza testo», 4-5★). Interrotto.`);
      process.exit(1);
    }
    const prima = correnti.find((x) => x.id === id)!;
    const a = automazioneDi(r);
    console.log(`«${r.nome}» [${r.attiva ? "attiva" : "SPENTA"}]`);
    console.log(`   prima: ${automazioneDi(prima).modo}`);
    console.log(
      `   dopo:  ${a.modo}` +
        (a.modo === "manuale"
          ? ""
          : ` · giorni ${a.giorni.join(",")} · ${a.daOra}:00-${a.aOra}:00 · pausa ${a.pausa ? `${a.pausa.daOra}:00-${a.pausa.aOra}:00` : "nessuna"} · attesa ${a.ritardoMinuti} min · attiva dal ${a.attivaDal}`),
    );
    if (!r.attiva) console.log("   ATTENZIONE: la regola è spenta, il pilota non la userà finché non la accendi.");
  }

  if (!scrivi && !spegni) {
    console.log("\n[PROVA] Niente scritto. Rilancia con --scrivi.");
    process.exit(0);
  }
  await scriviRegole(
    nuove,
    "importazione",
    spegni ? "automazione spenta su 4-5★ senza testo" : "automazione a fasce su 4-5★ senza testo (lun-ven 9-18, pausa 13-14, +15 min)",
  );
  console.log(`\n✅ ${spegni ? "Tornate manuali." : "Scritto."}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
