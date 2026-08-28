import { mkdirSync, readFileSync } from "fs";
import path from "path";
import {
  codaDaPubblicare,
  leggiPubblicazione,
  linkGoogle,
  segnaPubblicata,
} from "@/server/db/pubblicazioni";
import { chiudiFreshdeskPer } from "@/server/pubblicazione";
import { OPERATORE_SISTEMA } from "@/server/db/attivita";
import { loadSettings } from "@/server/settings";
import {
  apriContesto,
  pubblicaRisposta,
  sessioneAttiva,
  trovaRecensione,
  SCREENSHOT_DIR,
} from "@/server/robot/google";

// Worker del robot: per ogni risposta in coda apre la recensione su Google, la
// trova e fa uno screenshot. Di DEFAULT è dry-run (non invia niente).
//
//   npm run robot:pubblica              -> dry-run (naviga, trova, screenshot)
//   npm run robot:pubblica -- --vai     -> invia DAVVERO, ma SOLO se l'app è in
//                                          modalità Reale (doppia sicurezza)
//   ... -- --headless                   -> senza finestra (sconsigliato con Google)

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

(async () => {
  const flagVai = process.argv.includes("--vai");
  const headless = process.argv.includes("--headless");

  const s = await loadSettings();
  const modoReale = s.modo === "reale";
  const inviaDavvero = flagVai && modoReale;

  console.log(`Modalità app: ${modoReale ? "REALE" : "simulazione"} | flag --vai: ${flagVai ? "sì" : "no"}`);
  console.log(
    inviaDavvero
      ? ">>> INVIO REALE ATTIVO: il robot pubblicherà su Google e chiuderà i ticket.\n"
      : ">>> DRY-RUN: naviga, trova e fa screenshot. NON invia e NON chiude nulla.\n",
  );

  // Solo 5★ senza commento, come in app.
  const coda = (await codaDaPubblicare()).filter((v) => v.stelle === 5 && !v.testoRecensione);
  if (coda.length === 0) {
    console.log("Coda vuota: niente da pubblicare.");
    process.exit(0);
  }
  console.log(`In coda: ${coda.length} risposte.\n`);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ctx = await apriContesto(headless);
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  if (!(await sessioneAttiva(page))) {
    console.log("Sessione Google NON attiva. Esegui prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  let pubblicate = 0;
  let saltate = 0;
  for (const v of coda) {
    const link = linkGoogle(v);
    console.log(`• ${v.nomeCliente} — ${v.sedeNome || "sede ?"} (${v.stelle}★)`);
    const bersaglio = {
      chiave: v.chiave,
      nomeCliente: v.nomeCliente,
      stelle: v.stelle,
      testoRisposta: v.testoRisposta,
      urlSede: link.url,
    };

    const esito = await trovaRecensione(page, bersaglio).catch((e) => ({
      stato: "assente" as const,
      dettaglio: `errore navigazione: ${e instanceof Error ? e.message : e}`,
    }));
    const shot = path.join(SCREENSHOT_DIR, `${v.chiave.replace(/[^a-z0-9]/gi, "_")}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    console.log(`  ${esito.stato}: ${esito.dettaglio}`);
    console.log(`  screenshot: ${shot}${link.generico ? "  (link sede generico)" : ""}`);

    if (!inviaDavvero) {
      saltate++;
      continue;
    }
    if (esito.stato !== "trovata") {
      console.log("  salto: recensione non individuata in modo univoco.");
      saltate++;
      continue;
    }

    // Invio reale: prima Google, e SOLO se va a buon fine si aggiorna lo stato e
    // si chiude il ticket. Così lo stato non si sfasa mai rispetto a Google.
    try {
      await pubblicaRisposta(page, bersaglio);
      await segnaPubblicata(v.chiave, OPERATORE_SISTEMA);
      const voce = await leggiPubblicazione(v.chiave);
      if (voce) await chiudiFreshdeskPer(voce, "Robot Google");
      console.log("  pubblicata ✓ e ticket aggiornato.");
      pubblicate++;
    } catch (e) {
      console.log(`  invio NON riuscito (selettori da calibrare?): ${e instanceof Error ? e.message : e}`);
      saltate++;
    }
  }

  await ctx.close();
  console.log(`\nFatto. Pubblicate: ${pubblicate}, saltate: ${saltate}, totale coda: ${coda.length}.`);
  process.exit(0);
})().catch((e) => {
  console.error("\nERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
