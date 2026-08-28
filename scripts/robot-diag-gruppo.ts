import { mkdirSync } from "fs";
import path from "path";
import { apriContesto, sessioneAttiva, SCREENSHOT_DIR } from "@/server/robot/google";

// Diagnostica MIRATA del raggruppamento sedi.
// Apre il menu in alto a sinistra, ELENCA ogni voce (tag/role/aria/visibile),
// poi PROVA 5 modi diversi di cliccare il gruppo e dopo ognuno verifica se
// l'etichetta cambia davvero e se la lista si accorcia. Così scopriamo con
// certezza quale metodo funziona e lo mettiamo nel robot.
//
//   npm run robot:diag-gruppo -- "Point Attivi"      (gruppo, default Point Attivi)
//   npm run robot:diag-gruppo -- "Point Attivi" "Margherita del Canto"

type Voce = {
  text: string;
  tag: string;
  role: string | null;
  ariaChecked: string | null;
  ariaLabel: string | null;
  visible: boolean;
  x: number;
  y: number;
};

const GRUPPO = (process.argv[2] || "Point Attivi").trim();
const NOME = (process.argv[3] || "Margherita del Canto").trim();

(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!(await sessioneAttiva(page))) {
    console.log("Non loggato. Fai prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  const re = new RegExp(GRUPPO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const controllo = () =>
    page.getByRole("button", { name: /non raggruppati|breve termine|point attivi/i }).first();
  const etichetta = async () => {
    const t = controllo();
    return (await t.count().catch(() => 0)) ? ((await t.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim() : "(nessuna)";
  };
  const contaRispondi = () => page.getByRole("button", { name: /Rispondi/i }).count().catch(() => 0);

  await page.goto("https://business.google.com/reviews", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(500);

  console.log("\n===== PRIMA =====");
  console.log("URL      :", page.url());
  console.log("etichetta:", await etichetta());
  console.log("Rispondi :", await contaRispondi());

  // 1) apri il menu e fotografa
  console.log(`\nApro il menu del raggruppamento…  (controllo trovato: ${await controllo().count().catch(() => 0)})`);
  await controllo().click().catch((e) => console.log("  click apertura ERRORE:", (e as Error).message.split("\n")[0]));
  await page.waitForTimeout(1500);
  const shotMenu = path.join(SCREENSHOT_DIR, "diag-menu-aperto.png");
  await page.screenshot({ path: shotMenu }).catch(() => {});
  console.log("screenshot menu aperto:", shotMenu);

  // 2) elenca le voci del menu con i loro attributi
  const voci: Voce[] = await page.evaluate((nomi: string[]) => {
    const out: Voce[] = [];
    const sel = "[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],li,button,[role=button]";
    for (const e of Array.from(document.querySelectorAll(sel))) {
      const text = (e.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 40) continue;
      if (!nomi.some((n) => text.toLowerCase() === n.toLowerCase())) continue;
      const r = e.getBoundingClientRect();
      out.push({
        text,
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute("role"),
        ariaChecked: e.getAttribute("aria-checked"),
        ariaLabel: e.getAttribute("aria-label"),
        visible: r.width > 0 && r.height > 0,
        x: Math.round(r.x),
        y: Math.round(r.y),
      });
    }
    return out;
  }, ["Non raggruppati", "Breve Termine", "Point Attivi", GRUPPO]);
  console.log("\nVOCI DEL MENU (com'è fatto ciascuna):");
  console.log(JSON.stringify(voci, null, 2));

  // 3) prova 5 metodi di click, riaprendo il menu tra un tentativo e l'altro
  const metodi: [string, () => ReturnType<typeof page.getByText>][] = [
    ["ruolo menuitemradio", () => page.getByRole("menuitemradio", { name: re }).first()],
    ["ruolo menuitem", () => page.getByRole("menuitem", { name: re }).first()],
    ["ruolo option", () => page.getByRole("option", { name: re }).first()],
    ["testo esatto", () => page.getByText(GRUPPO, { exact: true }).first()],
    ["testo esatto + force", () => page.getByText(GRUPPO, { exact: true }).first()],
  ];

  let vincente = "";
  for (let i = 0; i < metodi.length; i++) {
    const [nome, fabbrica] = metodi[i];
    // assicurati che il menu sia aperto
    if ((await page.getByText(GRUPPO, { exact: true }).first().count().catch(() => 0)) === 0) {
      await controllo().click().catch(() => {});
      await page.waitForTimeout(1200);
    }
    const voce = fabbrica();
    const trovata = (await voce.count().catch(() => 0)) > 0;
    if (!trovata) {
      console.log(`\n[${nome}] voce NON trovata con questo selettore.`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }
    const force = nome.includes("force");
    await voce.click({ timeout: 4000, force }).catch((e) => console.log(`[${nome}] click errore: ${(e as Error).message.split("\n")[0]}`));
    await page.waitForTimeout(3000);
    const et = await etichetta();
    const ok = re.test(et);
    console.log(`\n[${nome}] → etichetta ora: "${et}"  ${ok ? "✅ FUNZIONA" : "❌ invariata"}`);
    if (ok) {
      vincente = nome;
      break;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }

  // 4) stato finale + verifica che il nome sia presente scrollando un po'
  console.log("\n===== DOPO =====");
  console.log("metodo vincente:", vincente || "NESSUNO (nessun metodo ha cambiato il gruppo)");
  console.log("URL      :", page.url());
  console.log("etichetta:", await etichetta());
  console.log("Rispondi :", await contaRispondi());

  if (vincente) {
    console.log(`\nCerco «${NOME}» scrollando un po' dentro il gruppo…`);
    let trovato = 0;
    for (let s = 0; s < 6; s++) {
      trovato = await page.getByText(NOME, { exact: false }).count().catch(() => 0);
      console.log(`  scroll ${s}: «${NOME}» presente = ${trovato}`);
      if (trovato > 0) break;
      await page.mouse.wheel(0, 1600).catch(() => {});
      await page.waitForTimeout(1200);
    }
    console.log(trovato > 0 ? `\n✅ TROVATA «${NOME}» nel gruppo ${GRUPPO}!` : `\n⚠️ Non ancora visibile scrollando (ma il gruppo è giusto).`);
  }

  const shot = path.join(SCREENSHOT_DIR, "diag-gruppo-dopo.png");
  await page.screenshot({ path: shot }).catch(() => {});
  console.log("screenshot finale:", shot);

  console.log("\n>>> Lascio il browser APERTO: guarda l'etichetta e la lista.");
  console.log(">>> Premi INVIO qui per chiudere.\n");
  await new Promise<void>((ok) => process.stdin.once("data", () => ok()));
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
