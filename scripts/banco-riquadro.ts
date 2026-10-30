import { chromium } from "playwright";
import { cercaNellaCoda, pubblica } from "@/server/robot/google";

// IL CASO NUOVO DI GOOGLE, riprodotto dal passo-passo vero del 30/10/2026
// («gianluca laterza», Bari Aeroporto):
//
//   - il riquadro di risposta è GIÀ APERTO quando il robot arriva;
//   - sta dentro un IFRAME (www.google.com/local/business/<id>/);
//   - NON c'è «Ignora» e NON c'è il contatore «N di M recensioni»;
//   - ci sono: il link all'autore, il testo, il campo e il tasto «Rispondi».
//
// Col vecchio conteggio questo valeva 1 indizio su 3 — e per giunta il campo
// veniva trovato nella PAGINA invece che nell'iframe — così il robot se ne
// andava a cercare la coda altrove mentre la recensione era lì davanti.

const NOME = "gianluca laterza";
const TESTO_DB =
  "Servizio al top, noleggio spesso da loro. Ragazzi disponibili ed efficienti con prezzi davvero ottimi";
const RISPOSTA = "Gentile signor Laterza,\r\nsiamo lieti che continui a rinnovare la fiducia.\r\nA presto.";

/** Il riquadro come lo mostra Google adesso: niente «Ignora», niente contatore. */
const DIALOGO = `
<!doctype html><meta charset="utf-8"><title>riquadro</title>
<body>
  <div role="dialog" aria-label="Rispondi alla recensione">
    <button>Indietro</button><button>Menu</button><button>Chiudi</button>
    <article>
      <a href="https://www.google.com/maps/contrib/112233/reviews?hl=it" jsname="xs1xe">${NOME}<i class="google-symbols notranslate" aria-hidden="true">open_in_new</i></a>
      <span role="img" aria-label="5 su 5 stelle"></span><span> 16 ore fa</span>
      <div class="testo">${TESTO_DB}</div>
    </article>
    <div class="proprietario">Galdieri Rent Bari Aeroporto · Proprietario</div>
    <textarea id="campo" placeholder="Risposta pubblica"></textarea>
    <button id="invia">Rispondi</button>
  </div>
  <script>
    window.__pubblicato = false;
    document.getElementById("invia").addEventListener("click", function () { window.__pubblicato = true; });
  </script>
</body>`;

/** La pagina della sede: il dialogo vive in un iframe, come nel caso vero. */
const PAGINA = `
<!doctype html><meta charset="utf-8"><title>sede</title>
<body>
  <h1>Galdieri Rent Bari Aeroporto</h1>
  <button>Leggi recensioni</button>
  <iframe id="dlg" style="width:760px;height:560px;border:0" srcdoc='${DIALOGO.replace(/'/g, "&apos;")}'></iframe>
</body>`;

async function main() {
  // Prima il browser di Playwright; se non è installato (succede sui PC dove
  // c'è solo il Chrome vero del robot) si ripiega su quello di sistema.
  const browser = await chromium
    .launch({ headless: true })
    .catch(() => chromium.launch({ headless: true, channel: "chrome" }));
  const page = await browser.newPage();
  await page.setContent(PAGINA);
  await page.waitForTimeout(400);

  const passi: string[] = [];
  const esito = await cercaNellaCoda(page, NOME, RISPOSTA, {
    log: (m) => passi.push(m),
    uscita: "lascia", // come il «Rispondi» vero: scrive e poi si pubblica
    maxIgnora: 6,
    testoRecensione: TESTO_DB,
  });

  let pubblicaOk = false;
  if (esito.trovata && esito.scritto) {
    try {
      await pubblica(esito.root ?? page);
      pubblicaOk = true;
    } catch (e) {
      passi.push(`pubblica() FALLITA: ${e instanceof Error ? e.message : e}`);
    }
  }

  const frame = page.frames().find((f) => f.name() !== "" || f !== page.mainFrame());
  const scritto = await frame?.evaluate(() => (document.getElementById("campo") as HTMLTextAreaElement)?.value ?? "");
  const pubblicato = await frame?.evaluate(() => (window as unknown as { __pubblicato: boolean }).__pubblicato);

  console.log("--- passo-passo ---");
  passi.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p}`));
  console.log("\n--- esito ---");
  console.log(`  trovata: ${esito.trovata} · scritto: ${esito.scritto} · autore «${esito.autore ?? ""}»`);
  console.log(`  dettaglio: ${esito.dettaglio}`);
  console.log(`  nel campo: «${(scritto ?? "").replace(/\n/g, " ⏎ ")}»`);
  console.log(`  pubblicato: ${pubblicato}`);

  const atteso = RISPOSTA.replace(/\r\n/g, "\n").trim();
  const controlli: [string, boolean][] = [
    ["riconosce il riquadro già aperto nell'iframe", passi.some((p) => p.includes("riquadro di risposta"))],
    ["NON si arrende («non mi fido»)", !passi.some((p) => p.includes("non mi fido"))],
    ["trova la recensione", esito.trovata === true],
    ["riconosce l'autore giusto", (esito.autore ?? "").includes("gianluca")],
    ["scrive la risposta", esito.scritto === true],
    ["nel campo c'è esattamente la risposta", (scritto ?? "").trim() === atteso],
    ["clicca «Rispondi» quando glielo si chiede", pubblicaOk && pubblicato === true],
  ];
  console.log("\n--- controlli ---");
  let ko = 0;
  for (const [nome, ok] of controlli) {
    if (!ok) ko++;
    console.log(`  ${ok ? "ok  " : "KO  "} ${nome}`);
  }
  await browser.close();
  console.log(ko === 0 ? "\nTUTTO A POSTO." : `\n${ko} CONTROLLI FALLITI.`);
  process.exit(ko === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
