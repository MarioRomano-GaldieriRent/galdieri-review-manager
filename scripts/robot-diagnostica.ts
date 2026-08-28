import { mkdirSync } from "fs";
import path from "path";
import { apriContesto, scrollaGiu, sessioneAttiva, SCREENSHOT_DIR } from "@/server/robot/google";

// Diagnostica della pagina recensioni: struttura, controlli (paginazione /
// "carica altre" / ordinamento / filtri) e se lo scroll fa crescere la lista.
//
//   npm run robot:diagnostica

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

  // Torna in cima e fotografa (lì stanno filtri/ordinamento/eventuali pagine).
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);
  const top = path.join(SCREENSHOT_DIR, "recensioni-top.png");
  await page.screenshot({ path: top }).catch(() => {});
  console.log("screenshot TOP  :", top);

  const contaRisp = () => page.getByRole("button", { name: /Rispondi/i }).count().catch(() => 0);
  console.log("Rispondi iniziali:", await contaRisp());

  const controlli = await page
    .$$eval("button, a, [role=button]", (els) =>
      els
        .map((e) => (e.textContent || "").trim())
        .filter(
          (t) =>
            t &&
            t.length < 40 &&
            /(altr|caric|mostra|success|avant|precedent|pagina|more|next|load|filtr|ordin|recent|stell|risposta)/i.test(
              t,
            ),
        ),
    )
    .catch(() => []);
  console.log("controlli candidati:", JSON.stringify([...new Set(controlli)]));

  // Scorri e osserva se la lista cresce (scroll infinito) o resta ferma (pagine).
  let prec = -1;
  let fermo = 0;
  for (let i = 0; i < 10; i++) {
    const n = await contaRisp();
    console.log(`scroll ${i}: Rispondi = ${n}${n === prec ? "  (non cresce)" : ""}`);
    if (n === prec) fermo++;
    else fermo = 0;
    prec = n;
    if (fermo >= 3) {
      console.log("  → la lista non cresce più: probabile PAGINAZIONE o fine.");
      break;
    }
    await scrollaGiu(page);
    await page.waitForTimeout(1300);
  }

  const fondo = path.join(SCREENSHOT_DIR, "recensioni-fondo.png");
  await page.screenshot({ path: fondo }).catch(() => {});
  console.log("screenshot FONDO:", fondo);
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
