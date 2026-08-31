import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  apriContesto,
  apriSedePerNome,
  cercaClienteNelleRecensioni,
  sessioneAttiva,
  SCREENSHOT_DIR,
} from "@/server/robot/google";

// TEST della «parte 2» del mapping. Quattro passi, in ordine:
//   1. cerca SOLO il nome dell'attività (la sede) nella barra di Google;
//   2. clicca l'attività;
//   3. clicca «Leggi recensioni»;
//   4. cerca il nome del CLIENTE nel campo di ricerca delle recensioni.
// Sola lettura: non scrive né pubblica. Lascia la finestra aperta; screenshot
// di ogni tappa in data/robot-screenshot.
//
// Prima chiudi TUTTE le finestre di Chrome (il robot apre il suo).
//
// SEDE e CLIENTE si passano in UN SOLO argomento fra virgolette, separati da //
// così la barra riceve SOLO la sede (mai sede + cliente):
//
//   npm run robot:prova-sede                        prima sede mappata, senza cliente
//   npm run robot:prova-sede -- "Nome attività"     apre solo la sede
//   npm run robot:prova-sede -- "Nome attività // Nome Cliente"   sede + poi il cliente
//
// Esempio:
//   npm run robot:prova-sede -- "Galdieri Rent Orio al Serio - Milan Bergamo // Arthur Lavallée"
//
// (Le sedi si mappano in Impostazioni → Mapping sedi.)

function caricaEnv() {
  try {
    const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const riga of txt.split(/\r?\n/)) {
      const m = riga.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* senza .env si prosegue */
  }
}
caricaEnv();

async function main() {
  // UN solo argomento: "sede // cliente". Tutto prima di // è la SEDE (va nella
  // barra di ricerca attività), tutto dopo è il CLIENTE (va nella ricerca delle
  // recensioni). Così la barra riceve SOLO la sede, mai sede + cliente.
  const raw = process.argv.slice(2).join(" ").trim();
  const parti = raw.split("//");
  const argNome = (parti[0] ?? "").trim();
  const cliente = (parti[1] ?? "").trim();

  let nomeGoogle = argNome;
  if (!nomeGoogle) {
    // Nessun argomento: leggo il mapping dal database e uso la prima sede.
    const { leggiSedi } = await import("@/server/db/sedi");
    const mappate = (await leggiSedi()).filter((s) => s.nomeGoogle.trim());
    if (mappate.length === 0) {
      console.log(
        "Nessuna sede mappata. Vai in Impostazioni → Mapping sedi e scrivi il nome Google di almeno una sede.",
      );
      process.exit(1);
    }
    console.log(`Sedi mappate (${mappate.length}):`);
    for (const s of mappate) console.log(`  - ${s.nome}  →  «${s.nomeGoogle}»`);
    nomeGoogle = mappate[0].nomeGoogle;
    console.log(`\nProvo la PRIMA. Per un'altra:  npm run robot:prova-sede -- "Nome Google"\n`);
  }

  console.log(`\nNella barra cerco SOLO l'attività: «${nomeGoogle}»`);
  console.log(`Poi, nelle recensioni, cerco il cliente: «${cliente || "(nessuno)"}»\n`);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!(await sessioneAttiva(page))) {
    console.log("Non risulti loggato su Google. Fai prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  const esito = await apriSedePerNome(page, nomeGoogle, { log: (m) => console.log("   " + m) });
  console.log(`\n→ ${esito.aperta ? "APERTA ✓" : "non aperta"} · via ${esito.via} · ${esito.dettaglio}`);

  // Se abbiamo un cliente e siamo sulle recensioni, lo cerchiamo con il campo
  // di ricerca delle recensioni (non scorrendo).
  if (cliente && esito.aperta) {
    console.log(`\nCerco la recensione di «${cliente}» in questa sede…`);
    const t = await cercaClienteNelleRecensioni(page, cliente, { log: (m) => console.log("   " + m) });
    console.log(`\n→ ${t.trovata ? "TROVATA ✓" : "non trovata"} · ${t.dettaglio}`);
  } else if (cliente) {
    console.log(`\n(Non cerco «${cliente}»: non sono arrivato alle recensioni della sede.)`);
  }

  console.log("\n>>> Lascio la finestra APERTA: guarda se sei sulle recensioni della sede giusta.");
  console.log(`>>> Screenshot delle tappe in: ${SCREENSHOT_DIR}`);
  console.log(">>> Quando hai finito, torna qui e premi INVIO per chiudere.\n");
  await new Promise<void>((ok) => process.stdin.once("data", () => ok()));

  await ctx.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
