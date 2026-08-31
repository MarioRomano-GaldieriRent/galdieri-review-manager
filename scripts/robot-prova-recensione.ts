import { mkdirSync } from "fs";
import path from "path";
import {
  annulla,
  apriContesto,
  cercaNeiGruppiPerPagina,
  sessioneAttiva,
  SCREENSHOT_DIR,
} from "@/server/robot/google";

// Test OSSERVABILE del match su UNA recensione (Margherita è solo un esempio).
// Cerca IN AMPIEZZA: prima pagina di ogni gruppo (Breve Termine / Non
// Raggruppati / Point Attivi), poi seconda pagina di ognuno, ecc. — una scheda
// per gruppo. Trovata la card scrive «Grazie» e si ferma (Annulla, NON pubblica).
// Lascia le schede aperte finché premi INVIO.
//
//   npm run robot:prova-recensione -- "Margherita del Canto"

(async () => {
  const nome = process.argv.slice(2).join(" ").trim() || "Margherita del Canto";
  console.log(`\nCerco (come TEST) la recensione di: «${nome}»\n`);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ctx = await apriContesto(false);
  const page0 = ctx.pages()[0] ?? (await ctx.newPage());

  if (!(await sessioneAttiva(page0))) {
    console.log("Non risulti loggato. Fai prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  const esito = await cercaNeiGruppiPerPagina(ctx, nome, "Grazie.", {
    log: (m) => console.log("   " + m),
  });
  console.log(`\n→ trovata: ${esito.trovata} · scritto: ${esito.scritto} · ${esito.dettaglio}`);

  if (esito.page) {
    const tag = (esito.gruppo || "match").replace(/\s+/g, "-").toLowerCase();
    await esito.page.screenshot({ path: path.join(SCREENSHOT_DIR, `match-${tag}.png`) }).catch(() => {});
  }

  console.log(esito.trovata ? "\nTROVATA. (Non ho pubblicato: è un test.)" : "\nNON trovata in nessun gruppo.");
  console.log("\n>>> Lascio le schede APERTE (una per gruppo): guardale pure.");
  console.log(">>> Quando hai finito, torna qui e premi INVIO per chiudere.\n");
  await new Promise<void>((ok) => process.stdin.once("data", () => ok()));

  // Scarta l'eventuale bozza scritta durante il test, poi chiudi.
  if (esito.page) await annulla(esito.page).catch(() => {});
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
