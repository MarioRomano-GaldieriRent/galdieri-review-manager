import path from "path";
import { execSync } from "node:child_process";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

// ---------------------------------------------------------------------------
// Automazione del browser per rispondere alle recensioni Google (l'API non è
// ancora disponibile). Principi:
//   - profilo PERSISTENTE e DEDICATO (data/robot-profilo), aperto col Chrome
//     REALE di sistema (channel "chrome"): al login Google è meno severo che con
//     il Chromium "da automazione". Il login si fa UNA volta e resta salvato.
//   - Chrome dev'essere CHIUSO quando gira il robot: è "istanza singola", se il
//     tuo Chrome è aperto il lancio verrebbe dirottato. Un controllo lo verifica.
//   - la parte che invia davvero (pubblicaRisposta) è volutamente non completata
//     coi selettori reali: si calibra dal vivo, così nulla parte per sbaglio.
//
// Il profilo contiene i cookie di login: è di fatto una credenziale, e sta sotto
// data/ (ignorato da git).
// ---------------------------------------------------------------------------

export const PROFILO_DIR =
  process.env.ROBOT_PROFILO_DIR || path.join(process.cwd(), "data", "robot-profilo");
export const SCREENSHOT_DIR =
  process.env.ROBOT_SCREENSHOT_DIR || path.join(process.cwd(), "data", "robot-screenshot");

/**
 * I gruppi di sedi su Google hanno CIASCUNO una pagina con URL proprio: si va
 * dritti lì invece di lottare col menu a tendina "Non raggruppati". Le
 * recensioni recenti sono in cima e si caricano scrollando.
 */
export const GRUPPI: { nome: string; url: string }[] = [
  { nome: "Point Attivi", url: "https://business.google.com/groups/112680153146377408716/reviews" },
  { nome: "Breve Termine", url: "https://business.google.com/groups/114345400402310855513/reviews" },
];

/** Su Windows: c'è un chrome.exe in esecuzione? (dirotterebbe il lancio). */
function chromeInEsecuzione(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: "utf8" });
    return /chrome\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** Apre il profilo dedicato del robot col Chrome reale. Chrome dev'essere chiuso. */
export async function apriContesto(headless = false): Promise<BrowserContext> {
  if (chromeInEsecuzione()) {
    throw new Error(
      "Chrome è APERTO: chiudi TUTTE le finestre di Chrome (e se resta l'icona nella tray → Esci), poi rilancia. Il robot deve aprire il suo browser e Chrome, essendo a istanza singola, lo dirotterebbe.",
    );
  }
  return chromium.launchPersistentContext(PROFILO_DIR, {
    channel: "chrome", // Chrome reale: al login Google accetta (a differenza del Chromium)
    headless,
    viewport: { width: 1360, height: 900 },
    locale: "it-IT", // interfaccia e pagine Google in italiano
    timezoneId: "Europe/Rome",
    args: ["--disable-blink-features=AutomationControlled", "--lang=it-IT"],
  });
}

/** Euristica: siamo loggati a Google (non veniamo rimandati alla pagina di login)? */
export async function sessioneAttiva(page: Page): Promise<boolean> {
  await page.goto("https://business.google.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
  return !/accounts\.google\.com\/(signin|v3\/signin|ServiceLogin)/i.test(page.url());
}

/** L'etichetta del gruppo attualmente selezionato (testo del controllo). */
async function etichettaGruppo(page: Page): Promise<string> {
  const t = page.getByRole("button", { name: /non raggruppati|breve termine|point attivi/i }).first();
  if ((await t.count().catch(() => 0)) === 0) return "";
  return ((await t.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
}

/**
 * Seleziona un gruppo di sedi dal menu in alto a sinistra ("Point Attivi",
 * "Breve Termine", "Non raggruppati"). Ritorna true SOLO se l'etichetta del
 * controllo cambia davvero nel gruppo scelto (verifica reale, non "cliccato").
 */
export async function selezionaGruppo(page: Page, nomeGruppo: string): Promise<boolean> {
  const re = new RegExp(nomeGruppo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (re.test(await etichettaGruppo(page))) return true; // già su quel gruppo

  const apri = page.getByRole("button", { name: /non raggruppati|breve termine|point attivi/i }).first();
  if ((await apri.count().catch(() => 0)) === 0) return false;

  // Fino a 3 tentativi: apri il menu, clicca la voce, verifica l'etichetta.
  for (let t = 0; t < 3; t++) {
    await apri.click().catch(() => {});
    await page.waitForTimeout(1000);
    const voci = [
      page.getByRole("menuitemradio", { name: re }),
      page.getByRole("menuitem", { name: re }),
      page.getByRole("option", { name: re }),
      page.getByText(nomeGruppo, { exact: true }),
    ];
    for (const loc of voci) {
      const v = loc.first();
      if ((await v.count().catch(() => 0)) > 0 && (await v.isVisible().catch(() => false))) {
        await v.click({ timeout: 4000 }).catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(3000); // lascia ricaricare la lista del gruppo
    if (re.test(await etichettaGruppo(page))) return true;
    await page.keyboard.press("Escape").catch(() => {});
  }
  return false;
}

// --- Azioni sulla casella di risposta (dopo aver premuto "Rispondi") ---------
// Etichette osservate sulla UI italiana: campo "La tua risposta", pulsanti
// "Pubblica risposta" e "Annulla". Locator per testo/ruolo: più stabili dei
// nomi di classe di Google, che cambiano di continuo.

/**
 * Nella casella aperta scrive il testo. Il campo di Google può essere una
 * textarea, un input o un contenteditable senza placeholder: si provano più
 * strategie con tempi brevi, e si digita con la tastiera (funziona ovunque).
 * Ritorna diagnostica: quale campo ha trovato e se "Pubblica" si è abilitato.
 */
export async function scriviRisposta(
  page: Page,
  testo: string,
): Promise<{ scritto: boolean; via: string; abilitato: boolean }> {
  const candidati: [string, Locator][] = [
    ["textbox-nome", page.getByRole("textbox", { name: /rispost/i })],
    ["placeholder", page.getByPlaceholder(/La tua risposta/i)],
    ["textarea-aria", page.locator('textarea[aria-label*="rispost" i]')],
    ["editable-aria", page.locator('[contenteditable="true"][aria-label*="rispost" i]')],
    ["textarea", page.locator("textarea")],
    ["editable", page.locator('[contenteditable="true"]')],
  ];

  let via = "nessuno";
  for (const [nome, loc] of candidati) {
    const c = await loc.count().catch(() => 0);
    if (c > 0) {
      const campo = loc.last();
      await campo.click({ timeout: 4000 }).catch(() => {});
      await page.keyboard.type(testo, { delay: 15 }).catch(() => {});
      via = `${nome} (trovati ${c})`;
      break;
    }
  }

  await page.waitForTimeout(400);
  const abilitato = await page
    .getByRole("button", { name: /Pubblica risposta/i })
    .isEnabled()
    .catch(() => false);
  return { scritto: via !== "nessuno", via, abilitato };
}

/** Clicca "Pubblica risposta". */
export async function pubblica(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Pubblica risposta/i }).click({ timeout: 8000 });
}

/** Clicca "Annulla" (scarta la bozza, non pubblica). */
export async function annulla(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /^Annulla$/i })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
}

// --- Match della recensione specifica -------------------------------------

/** Il pulsante "Rispondi" più vicino SOTTO l'elemento del nome (stessa card). */
async function rispondiVicinoA(page: Page, nomeEl: Locator): Promise<Locator | null> {
  const nameBox = await nomeEl.boundingBox().catch(() => null);
  if (!nameBox) return null;
  const buttons = page.getByRole("button", { name: /Rispondi/i });
  const count = await buttons.count().catch(() => 0);
  let best: Locator | null = null;
  let bestDy = Infinity;
  for (let i = 0; i < count; i++) {
    const b = buttons.nth(i);
    const box = await b.boundingBox().catch(() => null);
    if (box && box.y >= nameBox.y - 30) {
      const dy = box.y - nameBox.y;
      if (dy < bestDy) {
        bestDy = dy;
        best = b;
      }
    }
  }
  return bestDy < 380 ? best : null; // stessa card: il Rispondi è appena sotto il nome
}

/** Scorre il contenitore scrollabile più grande (o la finestra) verso il basso. */
export async function scrollaGiu(page: Page, px = 1200): Promise<void> {
  await page
    .evaluate((d) => {
      let best: Element | null = null;
      let bestH = 0;
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const h = el.clientHeight;
        if (el.scrollHeight > h + 200 && h > 300 && h > bestH) {
          best = el;
          bestH = h;
        }
      }
      (best ?? document.scrollingElement ?? document.body)?.scrollBy(0, d);
    }, px)
    .catch(() => {});
}

export type EsitoMatch = { trovata: boolean; scritto: boolean; dettaglio: string };

/** Va alla pagina successiva delle recensioni (pulsante "navigate_next"). true se avanza. */
async function vaiPaginaSuccessiva(page: Page): Promise<boolean> {
  const candidati = [
    page.getByRole("button", { name: /pagina successiva|successiv|next/i }),
    page.locator('button:has-text("navigate_next")'),
    page.locator('[aria-label*="successiv" i]'),
  ];
  for (const loc of candidati) {
    const b = loc.first();
    if ((await b.count().catch(() => 0)) === 0) continue;
    if (await b.isDisabled().catch(() => false)) return false;
    if (!(await b.isVisible().catch(() => false))) continue;
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click().catch(() => {});
    await page.waitForTimeout(1800);
    return true;
  }
  return false;
}

/**
 * Cerca la recensione del cliente SCROLLANDO la lista del gruppo (le recensioni
 * recenti sono in cima; scrollando se ne caricano altre). Se lo scroll non fa
 * più crescere la lista, prova a cambiare pagina. Trovata la card col nome, vi
 * individua il "Rispondi" (recensione senza risposta), clicca e scrive il testo.
 * NON pubblica: lo decide il chiamante. opts.log riceve una riga per passo.
 */
export async function trovaRecensioneEScrivi(
  page: Page,
  nomeCliente: string,
  testo: string,
  opts: { maxPassi?: number; log?: (m: string) => void } = {},
): Promise<EsitoMatch> {
  const maxPassi = opts.maxPassi ?? 80;
  const log = opts.log ?? (() => {});
  const nome = nomeCliente.trim();
  const contaRisp = () => page.getByRole("button", { name: /Rispondi/i }).count().catch(() => 0);

  await page
    .getByRole("button", { name: /Rispondi/i })
    .first()
    .waitFor({ timeout: 12000 })
    .catch(() => {});

  let fermo = 0;
  for (let s = 0; s <= maxPassi; s++) {
    const nomeLoc = page.getByText(nome, { exact: false });
    const nName = await nomeLoc.count().catch(() => 0);
    const nRisp = await contaRisp();
    log(`passo ${s + 1}: nome «${nome}» = ${nName} · «Rispondi» visibili = ${nRisp}`);

    if (nName > 0) {
      const primo = nomeLoc.first();
      await primo.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400);
      const rispondi = await rispondiVicinoA(page, primo);
      if (!rispondi) {
        return {
          trovata: true,
          scritto: false,
          dettaglio: `«${nome}» trovato, ma senza «Rispondi» (forse ha già risposta).`,
        };
      }
      await rispondi.scrollIntoViewIfNeeded().catch(() => {});
      await rispondi.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const r = await scriviRisposta(page, testo);
      return {
        trovata: true,
        scritto: r.scritto,
        dettaglio: `trovata al passo ${s + 1} · campo: ${r.via} · «Pubblica» abilitato: ${r.abilitato}`,
      };
    }

    // Non trovato: scrolla per caricare altre recensioni.
    await scrollaGiu(page, 1400);
    await page.waitForTimeout(1100);
    const dopo = await contaRisp();
    if (dopo <= nRisp) {
      // La lista non cresce più: prova a cambiare pagina, se esiste.
      if (await vaiPaginaSuccessiva(page)) {
        fermo = 0;
        continue;
      }
      fermo++;
      if (fermo >= 2) {
        log(`fine lista (nessuna nuova recensione caricata).`);
        break;
      }
    } else {
      fermo = 0;
    }
  }
  return { trovata: false, scritto: false, dettaglio: `«${nome}» non trovato nel gruppo.` };
}

export type Bersaglio = {
  chiave: string;
  nomeCliente: string;
  stelle: number | null;
  testoRisposta: string;
  urlSede: string;
};

export type EsitoTrova =
  | { stato: "trovata"; dettaglio: string }
  | { stato: "assente"; dettaglio: string }
  | { stato: "ambigua"; dettaglio: string };

/**
 * Cerca la recensione del cliente sulla pagina della sede, SENZA rispondere.
 * Placeholder: i selettori veri si calibrano dal vivo su una recensione di prova.
 */
export async function trovaRecensione(page: Page, b: Bersaglio): Promise<EsitoTrova> {
  await page.goto(b.urlSede, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const perNome = page.getByText(b.nomeCliente, { exact: false });
  const n = await perNome.count().catch(() => 0);
  if (n === 0) return { stato: "assente", dettaglio: `nessun elemento con «${b.nomeCliente}»` };
  if (n > 1)
    return { stato: "ambigua", dettaglio: `${n} elementi con lo stesso nome — serve l'occhio umano` };
  return { stato: "trovata", dettaglio: "un elemento corrisponde (da confermare in calibrazione)" };
}

/**
 * Pubblica la risposta. Non implementata coi selettori reali: si calibra dal
 * vivo. Lasciata a lanciare apposta, così finché non è calibrata non invia nulla.
 */
export async function pubblicaRisposta(page: Page, b: Bersaglio): Promise<void> {
  void page;
  void b;
  throw new Error(
    "pubblicaRisposta: i selettori di «Rispondi» vanno calibrati dal vivo su una recensione di prova.",
  );
}
