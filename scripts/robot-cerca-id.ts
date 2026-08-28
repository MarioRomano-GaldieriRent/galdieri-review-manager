import { readFileSync, mkdirSync } from "fs";
import path from "path";
import { MongoClient } from "mongodb";
import { apriContesto, scrollaGiu, sessioneAttiva, SCREENSHOT_DIR } from "@/server/robot/google";

// Verifica se l'ID Google della recensione compare nel DOM della pagina di
// gestione: se sì, il robot può agganciare la recensione ESATTA per id (100%
// affidabile). Legge l'id dal database in base al nome.
//
//   npm run robot:cerca-id -- "Margherita del Canto"

function loadEnv() {
  try {
    const t = readFileSync(".env", "utf8");
    for (const l of t.split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}
loadEnv();

(async () => {
  const nome = process.argv.slice(2).join(" ").trim() || "Margherita del Canto";

  const c = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 12000 });
  await c.connect();
  const rec = (await c
    .db(process.env.MONGODB_DB || "galdieri_recensioni")
    .collection("recensioni")
    .findOne({ nomeCliente: { $regex: nome, $options: "i" } })) as { idGoogleRecensione?: string } | null;
  await c.close();
  const id = rec?.idGoogleRecensione || "";
  console.log(`Recensione «${nome}» → idGoogle: ${id || "ASSENTE (rifai il sync)"}`);
  if (!id) process.exit(1);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!(await sessioneAttiva(page))) {
    console.log("Non loggato. Fai prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  await page.goto("https://business.google.com/reviews", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(3500);

  let trovato = false;
  for (let i = 0; i <= 40 && !trovato; i++) {
    const html = await page.content().catch(() => "");
    // l'id potrebbe comparire intero o in un frammento significativo
    if (html.includes(id) || html.includes(id.slice(6, 40))) {
      trovato = true;
      console.log(`scroll ${i}: ID TROVATO nel DOM ✓`);
      break;
    }
    console.log(`scroll ${i}: id non ancora nel DOM`);
    await scrollaGiu(page);
    await page.waitForTimeout(1000);
  }

  console.log(
    trovato
      ? "\n>>> L'ID è nel DOM: possiamo agganciare la recensione ESATTA per id (affidabile al 100%)."
      : "\n>>> L'ID NON compare nel DOM: il robot dovrà trovarla per nome/testo/sede.",
  );
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "cerca-id.png") }).catch(() => {});
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
