import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { apriContesto, apriSedePerNome, sessioneAttiva, SCREENSHOT_DIR } from "@/server/robot/google";

// TEST della «parte 2» del mapping: invece di battere i gruppi, il robot va su
// Google recensioni, CERCA la sede col nome mappato (nomeGoogle) e ne apre le
// recensioni. Lascia la finestra aperta così guardi se è finito sulla sede
// giusta; screenshot di ogni tappa in data/robot-screenshot.
//
// Prima chiudi TUTTE le finestre di Chrome (il robot apre il suo).
//
//   npm run robot:prova-sede                 usa la PRIMA sede mappata
//   npm run robot:prova-sede -- "Nome Google"  cerca quel nome
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
  const argNome = process.argv.slice(2).join(" ").trim();

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

  console.log(`Cerco la sede su Google: «${nomeGoogle}»\n`);
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
