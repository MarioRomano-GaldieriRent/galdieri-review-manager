import { mkdirSync } from "fs";
import path from "path";
import { apriContesto, sessioneAttiva, SCREENSHOT_DIR } from "@/server/robot/google";

// Apre il browser dedicato (già loggato con robot:sessione) e va alle recensioni.
// Cattura URL + screenshot. NON pubblica nulla.
//
//   npm run robot:recensioni
//
// Chrome dev'essere CHIUSO (il robot apre il suo browser). Se è aperto, lo script
// te lo dice e si ferma.

(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  console.log("Apro il browser del robot…");
  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  if (!(await sessioneAttiva(page))) {
    console.log("\nNon risulti loggato a Google. Fai prima il login:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }
  console.log("Sessione Google attiva ✓");

  await page.goto("https://business.google.com/reviews").catch(() => {});
  console.log("\n>>> Nella finestra, VAI fino alle recensioni di una sede.");
  console.log(">>> Quando le vedi, torna qui e premi INVIO: salvo URL e screenshot.\n");
  await new Promise<void>((ok) => process.stdin.once("data", () => ok()));

  const url = page.url();
  const shot = path.join(SCREENSHOT_DIR, "recensioni-test.png");
  try {
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`\nScreenshot salvato: ${shot}`);
  } catch (e) {
    await page.screenshot({ path: shot }).catch(() => {});
    console.log(
      `\nScreenshot (solo area visibile): ${shot}  [fullPage non riuscito: ${e instanceof Error ? e.message : e}]`,
    );
  }
  console.log(`URL della pagina: ${url}`);
  console.log("Fatto: lo screenshot è nel progetto, lo leggo io e passiamo alla calibrazione.");
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("\nERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
