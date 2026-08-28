import { mkdirSync } from "fs";
import path from "path";
import {
  annulla,
  apriContesto,
  scriviRisposta,
  sessioneAttiva,
  SCREENSHOT_DIR,
} from "@/server/robot/google";

// Calibrazione (SICURA): apre le recensioni, clicca il PRIMO "Rispondi", prova a
// scrivere un testo di PROVA, fa uno screenshot, e ANNULLA senza pubblicare.
// Stampa anche una diagnostica del campo di risposta (per capirne il tipo).
//
//   npm run robot:prova-rispondi

(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  console.log("Apro il browser del robot…");
  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  if (!(await sessioneAttiva(page))) {
    console.log("Non risulti loggato. Fai prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  await page
    .goto("https://business.google.com/reviews", { waitUntil: "domcontentloaded" })
    .catch(() => {});
  await page.waitForTimeout(3500);

  const rispondiTutti = page.getByRole("button", { name: /Rispondi/i });
  const n = await rispondiTutti.count().catch(() => 0);
  console.log(`Pulsanti "Rispondi" in vista: ${n}`);
  if (n === 0) {
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "senza-rispondi.png") }).catch(() => {});
    console.log("Nessun 'Rispondi' in vista: scorri fino a una recensione senza risposta e riprova.");
    await ctx.close();
    process.exit(1);
  }

  const primo = rispondiTutti.first();
  await primo.scrollIntoViewIfNeeded().catch(() => {});
  await primo.click().catch((e) => console.log("click Rispondi: " + (e instanceof Error ? e.message : e)));
  await page.waitForTimeout(1800);

  // Diagnostica: che campi ci sono dopo aver aperto la casella?
  const nTextarea = await page.locator("textarea").count().catch(() => 0);
  const nEditable = await page.locator('[contenteditable="true"]').count().catch(() => 0);
  const nTextbox = await page.getByRole("textbox").count().catch(() => 0);
  console.log(`Campi in pagina → textarea: ${nTextarea} · contenteditable: ${nEditable} · textbox: ${nTextbox}`);

  const r = await scriviRisposta(page, "prova del robot — questa NON verrà pubblicata");
  console.log(`Scrittura → campo: ${r.via} · scritto: ${r.scritto} · "Pubblica risposta" abilitato: ${r.abilitato}`);
  await page.waitForTimeout(500);

  const shot = path.join(SCREENSHOT_DIR, "rispondi-scritto.png");
  try {
    await page.screenshot({ path: shot, fullPage: true });
  } catch {
    await page.screenshot({ path: shot }).catch(() => {});
  }
  console.log(`Screenshot: ${shot}`);

  await annulla(page);
  console.log("ANNULLATO: nessuna risposta pubblicata. Chiudo.");
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
