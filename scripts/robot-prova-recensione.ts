import { mkdirSync } from "fs";
import path from "path";
import {
  annulla,
  apriContesto,
  GRUPPI,
  sessioneAttiva,
  SCREENSHOT_DIR,
  trovaRecensioneEScrivi,
} from "@/server/robot/google";

// Test OSSERVABILE del match su UNA recensione (Margherita è solo un esempio).
// Va DRITTO alla pagina di ogni gruppo (Point Attivi / Breve Termine hanno un
// URL proprio: niente menu a tendina), scrolla cercando il nome, scrive «Grazie»
// e si ferma (Annulla, NON pubblica). Lascia le schede aperte finché premi INVIO.
//
//   npm run robot:prova-recensione -- "Margherita del Canto"

const pausa = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

(async () => {
  const nome = process.argv.slice(2).join(" ").trim() || "Margherita del Canto";
  console.log(`\nCerco (come TEST) la recensione di: «${nome}»\n`);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ctx = await apriContesto(false);
  const pagine = [ctx.pages()[0] ?? (await ctx.newPage()), await ctx.newPage()];

  if (!(await sessioneAttiva(pagine[0]))) {
    console.log("Non risulti loggato. Fai prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  let esito = { trovata: false, scritto: false, dettaglio: "non cercata" };
  for (let i = 0; i < GRUPPI.length; i++) {
    const gr = GRUPPI[i];
    const page = pagine[i];
    console.log(`\n===== SCHEDA ${i + 1} · gruppo "${gr.nome}" =====`);
    await page.bringToFront().catch(() => {}); // porta questa scheda in primo piano
    console.log(`  1) vado dritto alla pagina del gruppo:`);
    console.log(`     ${gr.url}`);
    await page.goto(gr.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await pausa(3500);

    console.log(`  2) cerco «${nome}» scrollando (le recenti sono in cima)…`);
    esito = await trovaRecensioneEScrivi(page, nome, "Grazie.", {
      log: (m) => console.log("       " + m),
    });
    console.log(`  → trovata: ${esito.trovata} · scritto: ${esito.scritto} · ${esito.dettaglio}`);

    const shot = path.join(SCREENSHOT_DIR, `match-${gr.nome.replace(/\s+/g, "-").toLowerCase()}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    if (esito.trovata) break;
  }

  console.log(esito.trovata ? "\nTROVATA. (Non ho pubblicato: è un test.)" : "\nNON trovata in nessun gruppo.");
  console.log("\n>>> Lascio le DUE schede APERTE: guardale pure (una per gruppo).");
  console.log(">>> Quando hai finito, torna qui e premi INVIO per chiudere.\n");
  await new Promise<void>((ok) => process.stdin.once("data", () => ok()));

  await annulla(pagine[0]).catch(() => {});
  await annulla(pagine[1]).catch(() => {});
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
