import { mkdirSync } from "fs";
import path from "path";
import { apriContesto, sessioneAttiva, SCREENSHOT_DIR } from "@/server/robot/google";

// Apre il menu "Non raggruppati" (in alto a sinistra nelle recensioni) e ne
// fotografa le voci: servono i nomi esatti dei gruppi (Point / breve termine…)
// per far cercare il robot in ciascuno.
//
//   npm run robot:gruppi

(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!(await sessioneAttiva(page))) {
    console.log("Non loggato. Fai prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  await page.goto("https://business.google.com/reviews", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);

  const candidati = [
    page.getByRole("button", { name: /non raggruppati|raggrupp/i }),
    page.getByText(/non raggruppati/i),
    page.locator('[aria-label*="raggrupp" i]'),
  ];
  let cliccato = "";
  for (const c of candidati) {
    const b = c.first();
    if ((await b.count().catch(() => 0)) > 0 && (await b.isVisible().catch(() => false))) {
      cliccato = ((await b.textContent().catch(() => "")) || "").trim() || "(controllo)";
      await b.click().catch(() => {});
      break;
    }
  }
  console.log("controllo raggruppamento cliccato:", cliccato || "NESSUNO trovato");
  await page.waitForTimeout(1300);

  const voci = await page
    .$$eval("[role=menuitem], [role=option], [role=menuitemradio], li, button", (els) =>
      els.map((e) => (e.textContent || "").trim()).filter((t) => t && t.length < 50),
    )
    .catch(() => []);
  console.log("voci nel menu:", JSON.stringify([...new Set(voci)].slice(0, 30)));

  const shot = path.join(SCREENSHOT_DIR, "gruppi-menu.png");
  await page.screenshot({ path: shot }).catch(() => {});
  console.log("screenshot:", shot);
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
