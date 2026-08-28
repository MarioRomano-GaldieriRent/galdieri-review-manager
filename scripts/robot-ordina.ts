import { mkdirSync } from "fs";
import path from "path";
import { apriContesto, sessioneAttiva, SCREENSHOT_DIR } from "@/server/robot/google";

// Apre il controllo di ORDINAMENTO (in alto a destra nelle recensioni) e ne
// fotografa il menu, così vediamo le opzioni (es. "più recenti") da usare.
//
//   npm run robot:ordina

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
    page.getByRole("button", { name: /ordin/i }),
    page.getByRole("button", { name: /sort/i }),
    page.locator('[aria-label*="ordin" i]'),
    page.locator('button:has-text("sort")'),
    page.locator('button:has-text("filter_list")'),
  ];
  let cliccato = "";
  for (const c of candidati) {
    const b = c.first();
    if ((await b.count().catch(() => 0)) > 0 && (await b.isVisible().catch(() => false))) {
      cliccato = (await b.getAttribute("aria-label").catch(() => "")) || "(icona senza aria-label)";
      await b.click().catch(() => {});
      break;
    }
  }
  console.log("controllo ordinamento cliccato:", cliccato || "NESSUNO trovato");
  await page.waitForTimeout(1300);

  const opzioni = await page
    .$$eval("[role=menuitem], [role=option], [role=menuitemradio], li, button", (els) =>
      els
        .map((e) => (e.textContent || "").trim())
        .filter((t) => t && t.length < 45 && /(recent|data|più|piu|valut|stell|alt|bass|nuov|vecch|ordin)/i.test(t)),
    )
    .catch(() => []);
  console.log("opzioni menu:", JSON.stringify([...new Set(opzioni)]));

  const shot = path.join(SCREENSHOT_DIR, "ordina-menu.png");
  await page.screenshot({ path: shot }).catch(() => {});
  console.log("screenshot:", shot);
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
