import { mkdirSync } from "fs";
import path from "path";
import { apriContesto, sessioneAttiva, SCREENSHOT_DIR } from "@/server/robot/google";

// Tentativo di RIPRENDERE la sessione senza reinserire la password: a volte
// Google mostra «Disconnesso» ma un semplice clic sull'account basta (il
// dispositivo resta "ricordato"), senza richiedere di nuovo le credenziali.
//
// NON scrive né digita nessuna password: clicca solo la riga dell'account.
// Se compare una richiesta vera (password/2FA), si ferma lì e fotografa —
// quella parte tocca a una persona, non a questo script.
//
//   npm run robot:riprova-accesso

(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  await page
    .goto("https://business.google.com/reviews", { waitUntil: "domcontentloaded" })
    .catch(() => {});
  await page.waitForTimeout(2500);

  const scatto = async (tag: string) => {
    const p = path.join(SCREENSHOT_DIR, `riprova-accesso-${tag}.png`);
    await page.screenshot({ path: p }).catch(() => {});
    console.log("screenshot:", p);
    return p;
  };
  await scatto("1-arrivo");

  // Riga dell'account (non "Usa un altro account", non "Rimuovi un account").
  const riga = page
    .locator("li, div[role=link], [data-identifier]")
    .filter({ hasText: /galdierirent\.noleggio@gmail\.com/i })
    .first();

  if ((await riga.count().catch(() => 0)) === 0) {
    console.log(
      "Non vedo la riga dell'account (forse siamo già dentro, o la pagina è diversa dal solito). Guarda lo screenshot.",
    );
  } else {
    await riga.click({ timeout: 6000 }).catch(() => {});
    console.log('cliccato sulla riga dell\'account "galdierirent.noleggio@gmail.com".');
    await page.waitForTimeout(3000);
  }

  await scatto("2-dopo-click");

  const url = page.url();
  const attiva = await sessioneAttiva(page).catch(() => false);
  console.log("URL attuale:", url);
  console.log("sessioneAttiva():", attiva);

  if (/accounts\.google\.com/i.test(page.url())) {
    console.log(
      "\nSiamo ANCORA su un dominio di login di Google: probabilmente chiede password o 2FA veri.",
    );
    console.log(
      "NON ho scritto nulla: quella parte serve farla di persona con  npm run robot:sessione",
    );
  } else if (attiva) {
    console.log("\nSessione ripresa senza reinserire nulla. Si può procedere con il test su «D».");
  }

  await page.waitForTimeout(1500);
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
