import { readFileSync } from "node:fs";
import path from "node:path";
import type { Automazione, Regola } from "@/server/automation/types";

// Mette in AUTOMATICO le regole che il pilota sa fare da solo:
//
//  - POSITIVE «5 stelle senza testo» e «4 stelle senza testo» (decisione di
//    Mario, 14/9/2026): dalle 9:00 alle 18:00, pausa dalle 13:00 alle 14:00,
//    15 minuti dopo l'arrivo della recensione;
//  - NEGATIVE «1 e 2 stelle — escalation» (22/9/2026): l'inoltro a Cherubina
//    parte subito a qualunque ora, la sua risposta si pubblica nella stessa
//    fascia ma senza attesa (per queste regole il pilota la ignora).
//
// TUTTI I GIORNI, sabato e domenica compresi, con la stessa fascia (Mario,
// 22/9/2026: «così le smaltiamo tutte»). Prima era dal lunedì al venerdì, e le
// recensioni e le risposte del weekend partivano tutte insieme il lunedì.
//
// La pausa è 13→14: la richiesta diceva «dalle 13 fino alle 12», e 13-14 è la
// stessa pausa che il customer care dichiara nelle sue risposte automatiche
// («dalle 9:00 alle 13:00 e dalle 14:00 alle 18:00»).
//
// Scrivere qui NON fa partire niente da solo: il pilota gira solo sul server che
// ha AUTOPILOTA=1 nel .env, e le negative le lavora solo il codice dal 28bbb4e
// in poi. Una volta acceso lavora TUTTE le recensioni della regola ancora da
// rispondere, arretrato compreso.
//
//   npx tsx --tsconfig tsconfig.json scripts/accendi-automazione.ts            → PROVA
//   npx tsx --tsconfig tsconfig.json scripts/accendi-automazione.ts --scrivi   → scrive
//   npx tsx --tsconfig tsconfig.json scripts/accendi-automazione.ts --spegni   → tutte manuali

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

/** La fascia comune: tutti i giorni (0 = domenica … 6 = sabato), 9-18, pausa 13-14. */
const FASCIA = {
  giorni: [0, 1, 2, 3, 4, 5, 6],
  daOra: 9,
  aOra: 18,
  pausa: { daOra: 13, aOra: 14 },
};

const REGOLE: { id: string; tipo: "positiva" | "negativa"; ritardoMinuti: number }[] = [
  { id: "5-stelle-senza-testo", tipo: "positiva", ritardoMinuti: 15 },
  { id: "4-stelle-senza-testo", tipo: "positiva", ritardoMinuti: 15 },
  { id: "1-2-stelle", tipo: "negativa", ritardoMinuti: 0 },
];

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const spegni = process.argv.includes("--spegni");
  const { leggiRegole, scriviRegole } = await import("@/server/db/regole");
  const { regolaAutomatizzabile, regolaEscalationAutomatizzabile, automazioneDi } = await import(
    "@/server/automation/types"
  );

  const correnti = await leggiRegole();
  const ora = new Date().toISOString();
  const nuove: Regola[] = correnti.map((r) => {
    const voce = REGOLE.find((x) => x.id === r.id);
    if (!voce) return r;
    const automazione: Automazione = spegni
      ? { ...automazioneDi(r), modo: "manuale", attivaDal: null }
      : {
          modo: "programmato",
          ...FASCIA,
          ritardoMinuti: voce.ritardoMinuti,
          // Riaccendendo una regola già automatica si conserva la data vecchia.
          attivaDal:
            r.automazione?.modo && r.automazione.modo !== "manuale" && r.automazione.attivaDal
              ? r.automazione.attivaDal
              : ora,
        };
    return { ...r, automazione };
  });

  for (const voce of REGOLE) {
    const r = nuove.find((x) => x.id === voce.id);
    if (!r) {
      console.error(`Regola «${voce.id}» assente nel DB. Interrotto.`);
      process.exit(1);
    }
    const adatta = voce.tipo === "positiva" ? regolaAutomatizzabile(r) : regolaEscalationAutomatizzabile(r);
    if (!adatta) {
      console.error(
        `Regola «${voce.id}» non automatizzabile come ${voce.tipo} (${voce.tipo === "positiva" ? "serve «senza testo», 4-5★" : "serve inoltro + attesa della risposta, solo 1-2★"}). Interrotto.`,
      );
      process.exit(1);
    }
    const prima = correnti.find((x) => x.id === voce.id)!;
    const descrivi = (a: Automazione) =>
      a.modo === "manuale"
        ? "manuale"
        : `${a.modo} · giorni ${a.giorni.join(",") || "tutti"} · ${a.daOra}:00-${a.aOra}:00 · pausa ${a.pausa ? `${a.pausa.daOra}:00-${a.pausa.aOra}:00` : "nessuna"} · attesa ${a.ritardoMinuti} min · attiva dal ${a.attivaDal}`;
    console.log(`«${r.nome}» [${r.attiva ? "attiva" : "SPENTA"}]`);
    console.log(`   prima: ${descrivi(automazioneDi(prima))}`);
    console.log(`   dopo:  ${descrivi(automazioneDi(r))}`);
    if (!r.attiva) console.log("   ATTENZIONE: la regola è spenta, il pilota non la userà finché non la accendi.");
  }

  if (!scrivi && !spegni) {
    console.log("\n[PROVA] Niente scritto. Rilancia con --scrivi.");
    process.exit(0);
  }
  await scriviRegole(
    nuove,
    "importazione",
    spegni
      ? "automazione spenta su 4-5★ senza testo e 1-2★"
      : "automazione a fasce tutti i giorni 9-18, pausa 13-14: 4-5★ senza testo (+15 min) e 1-2★ (inoltro subito)",
  );
  console.log(`\n✅ ${spegni ? "Tornate manuali." : "Scritto."}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
