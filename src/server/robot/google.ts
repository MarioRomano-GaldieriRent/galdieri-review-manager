import path from "path";
import { execSync } from "node:child_process";
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from "playwright";

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
 * Contesto DOM su cui operare: la PAGINA o un suo IFRAME. Le recensioni di una
 * singola sede, aperte da Google Search con «Leggi recensioni», stanno dentro
 * un iframe: getByRole/getByText/locator vanno chiamati su QUEL frame, non sulla
 * pagina, altrimenti non trovano niente. Page e Frame condividono i metodi di
 * query; per tastiera, attese e screenshot serve la Page, che si ricava con
 * paginaDi().
 */
type Radice = Page | Frame;
function paginaDi(r: Radice): Page {
  return typeof (r as Frame).page === "function" ? (r as Frame).page() : (r as Page);
}

/**
 * I gruppi di sedi su Google hanno CIASCUNO una pagina con URL proprio: si va
 * dritti lì invece di lottare col menu a tendina. Le recensioni recenti stanno
 * in cima (pagina 1) di qualunque gruppo, quindi la ricerca è IN AMPIEZZA:
 * prima pagina di tutti e tre i gruppi, poi seconda pagina di tutti, poi terza…
 * (vedi cercaNeiGruppiPerPagina). L'ordine qui sotto è l'ordine di controllo.
 */
export const GRUPPI: { nome: string; url: string }[] = [
  { nome: "Breve Termine", url: "https://business.google.com/groups/114345400402310855513/reviews" },
  { nome: "Non Raggruppati", url: "https://business.google.com/groups/108435845803024212790/reviews" },
  { nome: "Point Attivi", url: "https://business.google.com/groups/112680153146377408716/reviews" },
];

/** Su Windows: c'è un chrome.exe in esecuzione? (dirotterebbe il lancio). */
export function chromeInEsecuzione(): boolean {
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
  root: Radice,
  testo: string,
): Promise<{ scritto: boolean; via: string; abilitato: boolean }> {
  const pg = paginaDi(root);
  const candidati: [string, Locator][] = [
    ["textbox-nome", root.getByRole("textbox", { name: /rispost/i })],
    ["placeholder", root.getByPlaceholder(/La tua risposta/i)],
    ["textarea-aria", root.locator('textarea[aria-label*="rispost" i]')],
    ["editable-aria", root.locator('[contenteditable="true"][aria-label*="rispost" i]')],
    ["textarea", root.locator("textarea")],
    ["editable", root.locator('[contenteditable="true"]')],
  ];

  let via = "nessuno";
  for (const [nome, loc] of candidati) {
    const c = await loc.count().catch(() => 0);
    if (c > 0) {
      const campo = loc.last();
      await campo.click({ timeout: 4000 }).catch(() => {});
      await pg.keyboard.type(testo, { delay: 15 }).catch(() => {});
      via = `${nome} (trovati ${c})`;
      break;
    }
  }

  await pg.waitForTimeout(400);
  const abilitato = await root
    .getByRole("button", { name: /Pubblica risposta/i })
    .isEnabled()
    .catch(() => false);
  return { scritto: via !== "nessuno", via, abilitato };
}

/** Clicca "Pubblica risposta". */
export async function pubblica(root: Radice): Promise<void> {
  await root.getByRole("button", { name: /Pubblica risposta/i }).click({ timeout: 8000 });
}

/** Clicca "Annulla" (scarta la bozza, non pubblica). */
export async function annulla(root: Radice): Promise<void> {
  await root
    .getByRole("button", { name: /^Annulla$/i })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
}

// --- Match della recensione specifica -------------------------------------

/** Il «Rispondi» (bottone o link) più vicino SOTTO l'elemento del nome (stessa card). */
async function rispondiVicinoA(root: Radice, nomeEl: Locator): Promise<Locator | null> {
  const nameBox = await nomeEl.boundingBox().catch(() => null);
  if (!nameBox) return null;
  const buttons = root
    .getByRole("button", { name: /rispondi/i })
    .or(root.getByRole("link", { name: /rispondi/i }));
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
export async function scrollaGiu(root: Radice, px = 1200): Promise<void> {
  await root
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
async function vaiPaginaSuccessiva(root: Radice): Promise<boolean> {
  const candidati = [
    root.getByRole("button", { name: /pagina successiva|successiv|next/i }),
    root.locator('button:has-text("navigate_next")'),
    root.locator('[aria-label*="successiv" i]'),
  ];
  for (const loc of candidati) {
    const b = loc.first();
    if ((await b.count().catch(() => 0)) === 0) continue;
    if (await b.isDisabled().catch(() => false)) return false;
    if (!(await b.isVisible().catch(() => false))) continue;
    await b.scrollIntoViewIfNeeded().catch(() => {});
    await b.click().catch(() => {});
    await paginaDi(root).waitForTimeout(1800);
    return true;
  }
  return false;
}

/** Quanti «Rispondi» (bottone o link) sono ora nella radice — misura della lista. */
async function contaRispondi(root: Radice): Promise<number> {
  const b = await root.getByRole("button", { name: /rispondi/i }).count().catch(() => 0);
  const l = await root.getByRole("link", { name: /rispondi/i }).count().catch(() => 0);
  return b + l;
}

/**
 * Porta la lista alla pagina SUCCESSIVA. Prima prova il pager esplicito
 * («pagina successiva»); se non c'è — lista a scorrimento continuo — scrolla e
 * considera avanzata la pagina solo se sono comparse nuove card. Ritorna false
 * quando non si va oltre: è la fine del gruppo.
 */
async function avanzaPagina(root: Radice): Promise<boolean> {
  if (await vaiPaginaSuccessiva(root)) return true;
  const prima = await contaRispondi(root);
  await scrollaGiu(root, 1600);
  await paginaDi(root).waitForTimeout(1200);
  return (await contaRispondi(root)) > prima;
}

/** La radice dove stanno le recensioni: la pagina, o l'iframe che le contiene. */
async function radiceConRecensioni(page: Page): Promise<Radice> {
  if ((await contaRispondi(page)) > 0) return page;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    if ((await contaRispondi(f).catch(() => 0)) > 0) return f;
  }
  return page;
}

/**
 * Cerca il nome SOLO nella pagina attualmente mostrata del gruppo (NON cambia
 * pagina: al cambio pagina pensa cercaNeiGruppiPerPagina). Fa al più qualche
 * scroll corto per far rendere le card di questa pagina. Trovata la card, vi
 * individua il «Rispondi» (recensione senza risposta), clicca e scrive il testo.
 */
async function cercaInPaginaCorrente(
  page: Page,
  nome: string,
  testo: string,
): Promise<EsitoMatch> {
  await page
    .getByRole("button", { name: /Rispondi/i })
    .first()
    .waitFor({ timeout: 12000 })
    .catch(() => {});

  for (let s = 0; s < 3; s++) {
    const nomeLoc = page.getByText(nome, { exact: false });
    if ((await nomeLoc.count().catch(() => 0)) > 0) {
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
        dettaglio: `campo: ${r.via} · «Pubblica» abilitato: ${r.abilitato}`,
      };
    }
    // Non ancora: scroll corto per far rendere il resto di QUESTA pagina.
    if (s < 2) {
      await scrollaGiu(page, 900);
      await page.waitForTimeout(600);
    }
  }
  return { trovata: false, scritto: false, dettaglio: "non in questa pagina" };
}

export type EsitoRicerca = {
  trovata: boolean;
  scritto: boolean;
  /** Il gruppo in cui è stata trovata (null se non trovata). */
  gruppo: string | null;
  /** La scheda dove si è fermato (per «cerca» resta in primo piano). */
  page: Page | null;
  dettaglio: string;
};

/**
 * Cerca la recensione IN AMPIEZZA fra i gruppi: prima pagina di ogni gruppo,
 * poi seconda pagina di ogni gruppo, poi terza… Le recensioni recenti stanno in
 * cima (pagina 1) di qualunque gruppo, quindi così si trova PRIMA ciò che è
 * appena arrivato, invece di svuotare un gruppo intero prima di passare al
 * successivo (che era il vecchio comportamento: rischiava di non arrivare mai a
 * «Breve Termine»).
 *
 * Una scheda dedicata per gruppo tiene il segno: a ogni giro si avanza di UNA
 * pagina e si guarda solo quella nuova — niente ri-scansioni delle già fatte.
 *
 * NON pubblica: apre «Rispondi» e scrive il testo; la pubblicazione la decide
 * il chiamante. Su match lascia in primo piano la scheda giusta.
 */
export async function cercaNeiGruppiPerPagina(
  ctx: BrowserContext,
  nomeCliente: string,
  testo: string,
  opts: { maxPagine?: number; log?: (m: string) => void } = {},
): Promise<EsitoRicerca> {
  const maxPagine = opts.maxPagine ?? 5;
  const log = opts.log ?? (() => {});
  const nome = nomeCliente.trim();

  // Una scheda per gruppo: la prima riusa quella già aperta del contesto.
  const esistenti = ctx.pages();
  const sessioni: { gr: (typeof GRUPPI)[number]; page: Page; esaurito: boolean }[] = [];
  for (let i = 0; i < GRUPPI.length; i++) {
    const page = esistenti[i] ?? (await ctx.newPage());
    sessioni.push({ gr: GRUPPI[i], page, esaurito: false });
  }

  // Pagina 1 di ogni gruppo.
  for (const s of sessioni) {
    await s.page.goto(s.gr.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  await sessioni[0].page.waitForTimeout(3000);

  for (let pagina = 1; pagina <= maxPagine; pagina++) {
    let vive = 0;
    for (const s of sessioni) {
      if (s.esaurito) continue;
      // Dalla 2ª pagina in poi: avanza PRIMA di guardare. Se non si va oltre,
      // il gruppo è finito: lo si salta nei giri successivi.
      if (pagina > 1 && !(await avanzaPagina(s.page))) {
        s.esaurito = true;
        log(`«${s.gr.nome}»: niente pagina ${pagina} (fine gruppo).`);
        continue;
      }
      vive++;
      await s.page.bringToFront().catch(() => {});
      log(`«${s.gr.nome}» · pagina ${pagina}: cerco «${nome}»…`);
      const e = await cercaInPaginaCorrente(s.page, nome, testo);
      if (e.trovata) {
        await s.page.bringToFront().catch(() => {});
        return {
          trovata: true,
          scritto: e.scritto,
          gruppo: s.gr.nome,
          page: s.page,
          dettaglio: `«${s.gr.nome}» pagina ${pagina} · ${e.dettaglio}`,
        };
      }
    }
    if (vive === 0) break; // tutti i gruppi esauriti
  }

  const nomi = GRUPPI.map((g) => g.nome).join(", ");
  return {
    trovata: false,
    scritto: false,
    gruppo: null,
    page: sessioni[0]?.page ?? null,
    dettaglio: `«${nome}» non trovata nelle prime ${maxPagine} pagine di: ${nomi}.`,
  };
}

export type EsitoSede = {
  aperta: boolean;
  via: string;
  dettaglio: string;
  /** La radice dove sono le recensioni (pagina o iframe): la usa chi cerca il cliente. */
  root?: Radice;
};

/**
 * Cerca una sede su Google PER NOME (il `nomeGoogle` mappato) e ne apre le
 * recensioni, senza passare per i gruppi: è la strada della «parte 2» del
 * mapping. I selettori di Google cambiano spesso, quindi questa è la prima
 * versione da CALIBRARE dal vivo — logga i passaggi, salva screenshot a ogni
 * tappa e prova più strategie. Ritorna se è arrivata a una lista di recensioni
 * (conta i pulsanti «Rispondi»).
 */
export async function apriSedePerNome(
  page: Page,
  nome: string,
  opts: { log?: (m: string) => void } = {},
): Promise<EsitoSede> {
  const log = opts.log ?? (() => {});
  const cerca = nome.trim();
  const scatto = async (tag: string) => {
    const p = path.join(SCREENSHOT_DIR, `prova-sede-${tag}.png`);
    await page.screenshot({ path: p }).catch(() => {});
    log(`screenshot: ${p}`);
  };

  await page
    .goto("https://business.google.com/reviews", { waitUntil: "domcontentloaded" })
    .catch(() => {});
  await page.waitForTimeout(3500);
  await scatto("1-arrivo");

  // Trova un campo di ricerca: prima direttamente in pagina, poi aprendo il
  // controllo in alto a sinistra (quello dei gruppi/sedi), che di solito porta
  // dentro un campo di ricerca delle sedi.
  const trovaCampo = async (): Promise<Locator | null> => {
    const campi = [
      page.getByRole("searchbox"),
      page.getByRole("combobox"),
      page.getByPlaceholder(/cerc|search/i),
      page.locator('input[type="search"]'),
      page.locator('input[aria-label*="cerc" i], input[aria-label*="search" i]'),
    ];
    for (const loc of campi) {
      const c = loc.first();
      if ((await c.count().catch(() => 0)) > 0 && (await c.isVisible().catch(() => false))) return c;
    }
    return null;
  };

  let campo = await trovaCampo();
  if (!campo) {
    log("nessun campo di ricerca diretto: apro il controllo sedi/gruppi in alto a sinistra…");
    const ctrl = page
      .getByRole("button", { name: /non raggruppati|raggrupp|point|breve termine|sedi|tutte le/i })
      .first();
    if ((await ctrl.count().catch(() => 0)) > 0) {
      await ctrl.click().catch(() => {});
      await page.waitForTimeout(1500);
      await scatto("2-picker");
      campo = await trovaCampo();
    }
  }

  if (!campo) {
    await scatto("2-senza-campo");
    return {
      aperta: false,
      via: "nessun-campo",
      dettaglio:
        "Non ho trovato un campo per cercare la sede. Guarda gli screenshot e dimmi com'è fatta la pagina.",
    };
  }

  await campo.click().catch(() => {});
  await campo.fill("").catch(() => {}); // via eventuale testo residuo
  await page.keyboard.type(cerca, { delay: 30 }).catch(() => {});
  log(`scritto «${cerca}» nel campo di ricerca`);
  await page.waitForTimeout(1600);
  await scatto("3-digitato");

  // Corrisponde se il testo contiene, nell'ordine, le parole del nome.
  const re = new RegExp(
    cerca
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .split(/\s+/)
      .join(".*"),
    "i",
  );
  const sonoSuRecensioni = async () =>
    (await page.getByRole("button", { name: /Rispondi/i }).count().catch(() => 0)) > 0;

  // Dump dei candidati + click del risultato-sede che corrisponde. Ritorna true
  // se ha cliccato qualcosa.
  const tentaRisultato = async (): Promise<boolean> => {
    const possibili = await page
      .$$eval("[role=option], [role=menuitem], a, li", (els) =>
        els
          .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
          .filter((t) => t && t.length < 60),
      )
      .catch(() => []);
    log(`risultati visibili (primi 15): ${JSON.stringify([...new Set(possibili)].slice(0, 15))}`);
    for (const loc of [
      page.getByRole("option", { name: re }),
      page.getByRole("menuitem", { name: re }),
      page.getByRole("link", { name: re }),
      page.getByText(re),
    ]) {
      const r = loc.first();
      if ((await r.count().catch(() => 0)) === 0) continue;
      if (!(await r.isVisible().catch(() => false))) continue;
      await r.click({ timeout: 6000 }).catch(() => {});
      log(`cliccato un risultato per «${cerca}»`);
      return true;
    }
    return false;
  };

  // 1) A volte i risultati compaiono già mentre scrivi (autocomplete).
  let cliccato = await tentaRisultato();

  // 2) Altrimenti LANCIA la ricerca con INVIO — molte UI mostrano i risultati
  //    solo dopo (era il «hai scritto ma non hai cercato») — poi riprova.
  if (!cliccato) {
    log("nessun risultato al volo: premo INVIO per lanciare la ricerca…");
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(3500);
    await scatto("3b-dopo-invio");
    cliccato = await tentaRisultato();
  }

  // 3) L'Invio può portare DRITTO alle recensioni della sede (match unico):
  //    in quel caso non c'è nulla da cliccare, ma va bene lo stesso.
  if (!cliccato && !(await sonoSuRecensioni())) {
    return {
      aperta: false,
      via: "senza-risultato",
      dettaglio: `Ho scritto «${cerca}» e premuto Invio, ma non ho trovato un risultato-sede da cliccare. Vedi 3-digitato e 3b-dopo-invio.`,
    };
  }
  if (!cliccato) log("l'Invio è bastato: la pagina mostra già delle recensioni.");

  await page.waitForTimeout(2500);
  await scatto("4-cliccato");

  // Siamo sulla scheda della sede (su Google Search): apri le recensioni con
  // «Leggi recensioni». Il pannello che si apre sta DENTRO UN IFRAME, quindi le
  // recensioni non sono nella pagina ma in un frame: lo individua radiceConRecensioni.
  const etichettaRec = /leggi recensioni|vedi recensioni|tutte le recensioni|gestisci recensioni|recensioni|read reviews|see reviews|reviews/i;
  let root: Radice = await radiceConRecensioni(page);
  if ((await contaRispondi(root)) === 0) {
    log("sulla scheda della sede: cerco «Leggi recensioni»…");
    for (const loc of [
      page.getByRole("button", { name: etichettaRec }),
      page.getByRole("link", { name: etichettaRec }),
      page.getByText(/leggi recensioni|read reviews/i),
    ]) {
      const v = loc.first();
      if ((await v.count().catch(() => 0)) === 0) continue;
      if (!(await v.isVisible().catch(() => false))) continue;
      await v.scrollIntoViewIfNeeded().catch(() => {});
      await v.click({ timeout: 6000 }).catch(() => {});
      log("cliccato «Leggi recensioni»");
      await page.waitForTimeout(3000);
      break;
    }
    root = await radiceConRecensioni(page);
  }
  if (root !== page) log("le recensioni sono dentro un iframe: opero lì.");

  // Scorri un po' così le recensioni si caricano (poi si cerca quella giusta).
  let nRisp = await contaRispondi(root);
  if (nRisp > 0) {
    await scrollaGiu(root, 700);
    await paginaDi(root).waitForTimeout(800);
    nRisp = await contaRispondi(root);
  }
  await scatto("5-recensioni");

  return {
    aperta: nRisp > 0,
    via: "ricerca",
    root,
    dettaglio:
      nRisp > 0
        ? `Sono sulle recensioni della sede: ${nRisp} «Rispondi»${root !== page ? " (in un iframe)" : ""}. Da qui si trova la recensione del cliente.`
        : "Ho aperto la sede ma non vedo ancora le recensioni («Rispondi»), nemmeno in un iframe. Guarda gli screenshot 4 e 5.",
  };
}

export type EsitoTrovaLista = { trovata: boolean; dettaglio: string };

/**
 * Nella lista di recensioni GIÀ APERTA (di una sede), scorre cercando il nome
 * del cliente. SOLA LETTURA: non apre «Rispondi» e non scrive nulla — porta
 * soltanto la card in vista. Se lo scroll non fa più crescere la lista, prova la
 * pagina successiva. È l'ultimo passo del flusso per-sede: aperto il posto, si
 * trova la sua recensione qui.
 */
export async function trovaRecensioneNellaLista(
  root: Radice,
  nomeCliente: string,
  opts: { maxPassi?: number; log?: (m: string) => void } = {},
): Promise<EsitoTrovaLista> {
  const maxPassi = opts.maxPassi ?? 60;
  const log = opts.log ?? (() => {});
  const nome = nomeCliente.trim();
  const pg = paginaDi(root);

  await root
    .getByRole("button", { name: /rispondi/i })
    .first()
    .waitFor({ timeout: 12000 })
    .catch(() => {});

  let fermo = 0;
  for (let s = 0; s <= maxPassi; s++) {
    const nomeLoc = root.getByText(nome, { exact: false });
    const nName = await nomeLoc.count().catch(() => 0);
    const nRisp = await contaRispondi(root);
    log(`passo ${s + 1}: «${nome}» = ${nName} · recensioni visibili = ${nRisp}`);

    if (nName > 0) {
      const primo = nomeLoc.first();
      await primo.scrollIntoViewIfNeeded().catch(() => {});
      await pg.waitForTimeout(400);
      return {
        trovata: true,
        dettaglio: `«${nome}» trovato al passo ${s + 1} e portato in vista (non toccato).`,
      };
    }

    await scrollaGiu(root, 1400);
    await pg.waitForTimeout(1000);
    const dopo = await contaRispondi(root);
    if (dopo <= nRisp) {
      if (await avanzaPagina(root)) {
        fermo = 0;
        continue;
      }
      fermo++;
      if (fermo >= 2) {
        log("fine lista.");
        break;
      }
    } else {
      fermo = 0;
    }
  }
  return { trovata: false, dettaglio: `«${nome}» non trovato scorrendo le recensioni della sede.` };
}

/**
 * Nelle recensioni GIÀ APERTE di una sede, trova la recensione del cliente
 * usando il CAMPO DI RICERCA delle recensioni: si scrive il nome e Google
 * filtra la lista — molto più affidabile che scorrere. Se il campo non c'è,
 * ripiega sullo scroll. SOLA LETTURA: non apre «Rispondi», non scrive nulla.
 */
export async function cercaClienteNelleRecensioni(
  root: Radice,
  nomeCliente: string,
  opts: { log?: (m: string) => void } = {},
): Promise<EsitoTrovaLista> {
  const log = opts.log ?? (() => {});
  const nome = nomeCliente.trim();
  const pg = paginaDi(root);
  const scatto = async (tag: string) => {
    const p = path.join(SCREENSHOT_DIR, `prova-sede-${tag}.png`);
    await pg.screenshot({ path: p }).catch(() => {});
    log(`screenshot: ${p}`);
  };

  // Diagnostica: elenca i campi di input VISIBILI nella radice (pagina o iframe),
  // per capire se c'è una ricerca DELLE RECENSIONI e agganciarla.
  const campiInfo = await root
    .locator("input, textarea, [role=searchbox], [role=combobox]")
    .evaluateAll((els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => ({
          tag: e.tagName.toLowerCase(),
          type: e.getAttribute("type") || "",
          role: e.getAttribute("role") || "",
          placeholder: e.getAttribute("placeholder") || "",
          aria: e.getAttribute("aria-label") || "",
        })),
    )
    .catch(() => [] as unknown[]);
  log(`campi di input: ${JSON.stringify(campiInfo).slice(0, 700)}`);

  // Il campo "cerca tra le recensioni" — deve riferirsi a RECENSIONI/recensore.
  const perRecensioni = /recensione|recensioni|recensore|review|reviewer/i;
  const trovaCampo = async (): Promise<Locator | null> => {
    for (const loc of [
      root.getByPlaceholder(perRecensioni),
      root.locator(
        'input[aria-label*="recension" i], input[aria-label*="recensore" i], input[aria-label*="review" i]',
      ),
      root.getByRole("searchbox", { name: perRecensioni }),
      root.getByRole("combobox", { name: perRecensioni }),
    ]) {
      const c = loc.first();
      if ((await c.count().catch(() => 0)) > 0 && (await c.isVisible().catch(() => false))) return c;
    }
    return null;
  };

  let campo = await trovaCampo();
  // Il campo può stare dietro un'icona "lente" da aprire prima.
  if (!campo) {
    const lente = root
      .getByRole("button", { name: /cerca.*recension|cerca nelle recension|search.*review/i })
      .first();
    if ((await lente.count().catch(() => 0)) > 0 && (await lente.isVisible().catch(() => false))) {
      await lente.click().catch(() => {});
      await pg.waitForTimeout(1000);
      campo = await trovaCampo();
    }
  }

  if (!campo) {
    log("nessun campo «cerca recensioni»: ripiego sullo scroll…");
    return trovaRecensioneNellaLista(root, nome, { log });
  }

  await campo.click().catch(() => {});
  await campo.fill("").catch(() => {});
  await pg.keyboard.type(nome, { delay: 30 }).catch(() => {});
  await pg.keyboard.press("Enter").catch(() => {});
  log(`scritto «${nome}» nel campo di ricerca delle recensioni`);
  await pg.waitForTimeout(3000);
  await scatto("6-cerca-cliente");

  const nName = await root.getByText(nome, { exact: false }).count().catch(() => 0);
  const nRisp = await contaRispondi(root);
  if (nName > 0) {
    await root
      .getByText(nome, { exact: false })
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await scatto("7-cliente");
    return {
      trovata: true,
      dettaglio: `«${nome}» filtrato con la ricerca delle recensioni (${nRisp} risultati visibili).`,
    };
  }
  await scatto("7-cliente");
  return {
    trovata: false,
    dettaglio: `Ho cercato «${nome}» nelle recensioni ma non compare (${nRisp} risultati). Vedi gli screenshot 6 e 7.`,
  };
}

export type EsitoRisposta = { scritto: boolean; via: string; abilitato: boolean; dettaglio: string };

/**
 * Trovata la recensione del cliente (già in vista dopo la ricerca), apre il
 * «Rispondi» accanto ad essa. NON pubblica MAI (non clicca «Pubblica risposta»).
 *
 * Il testo:
 *   - se `testo` è VUOTO → apre solo il riquadro, per dimostrare che si POTREBBE
 *     rispondere, ma NON scrive niente. È il test puro: nessuna scrittura.
 *   - se `testo` c'è → scrive quella bozza nel riquadro (comunque non pubblicata).
 */
export async function rispondiAllaRecensione(
  root: Radice,
  nomeCliente: string,
  testo: string,
  opts: { log?: (m: string) => void } = {},
): Promise<EsitoRisposta> {
  const log = opts.log ?? (() => {});
  const nome = nomeCliente.trim();
  const pg = paginaDi(root);
  const scatto = async (tag: string) => {
    const p = path.join(SCREENSHOT_DIR, `prova-sede-${tag}.png`);
    await pg.screenshot({ path: p }).catch(() => {});
    log(`screenshot: ${p}`);
  };

  const nomeLoc = root.getByText(nome, { exact: false }).first();
  if ((await nomeLoc.count().catch(() => 0)) === 0) {
    return {
      scritto: false,
      via: "nessun-nome",
      abilitato: false,
      dettaglio: `«${nome}» non è nella lista: va cercato prima.`,
    };
  }
  await nomeLoc.scrollIntoViewIfNeeded().catch(() => {});
  await pg.waitForTimeout(400);
  await scatto("8a-prima-rispondi");

  // DIAGNOSTICA: elenca i bottoni/link visibili nella radice (pagina o iframe),
  // così vediamo con che etichetta Google chiama «Rispondi» in questa vista.
  const bottoni = await root
    .locator("button, [role=button], a")
    .evaluateAll((els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) =>
          (e.textContent || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
        )
        .filter((t) => t && t.length < 40),
    )
    .catch(() => [] as string[]);
  log(`bottoni: ${JSON.stringify([...new Set(bottoni)].slice(0, 30))}`);

  // Il «Rispondi» accanto al nome; se la geometria non lo prende, ripiego sul
  // primo «Rispondi» in vista — la lista è filtrata sul cliente, quindi è il suo.
  const reRispondi = /rispondi|reply|risposta/i;
  let rispondi = await rispondiVicinoA(root, nomeLoc);
  if (!rispondi) {
    for (const loc of [
      root.getByRole("button", { name: reRispondi }),
      root.getByRole("link", { name: reRispondi }),
      root.getByText(/^rispondi$/i),
    ]) {
      const b = loc.first();
      if ((await b.count().catch(() => 0)) > 0 && (await b.isVisible().catch(() => false))) {
        rispondi = b;
        log("uso il primo «Rispondi» in vista (lista filtrata sul cliente).");
        break;
      }
    }
  }
  if (!rispondi) {
    return {
      scritto: false,
      via: "nessun-rispondi",
      abilitato: false,
      dettaglio: `Trovato «${nome}» ma nessun «Rispondi» cliccabile. Guarda 8a e la riga «bottoni» qui sopra.`,
    };
  }
  await rispondi.scrollIntoViewIfNeeded().catch(() => {});
  await rispondi.click({ timeout: 6000 }).catch(() => {});
  log("cliccato «Rispondi».");
  await pg.waitForTimeout(1200);
  await scatto("8b-dopo-rispondi");

  // Testo vuoto = apro solo il riquadro, senza scrivere.
  if (!testo.trim()) {
    const riquadro =
      (await root.locator('textarea, [contenteditable="true"]').count().catch(() => 0)) > 0 ||
      (await root.getByRole("button", { name: /Pubblica risposta/i }).count().catch(() => 0)) > 0;
    return {
      scritto: false,
      via: "solo-aperto",
      abilitato: false,
      dettaglio: riquadro
        ? "Riquadro di risposta APERTO — non ho scritto niente."
        : "Ho cliccato «Rispondi» ma non vedo comparire il riquadro.",
    };
  }

  const r = await scriviRisposta(root, testo);
  const p = path.join(SCREENSHOT_DIR, "prova-sede-8-risposta.png");
  await pg.screenshot({ path: p }).catch(() => {});
  log(`riquadro via ${r.via}; «Pubblica» abilitato: ${r.abilitato}; screenshot: ${p}`);
  return {
    scritto: r.scritto,
    via: r.via,
    abilitato: r.abilitato,
    dettaglio: r.scritto
      ? "«Rispondi» cliccato e testo SCRITTO nel riquadro — NON pubblicato."
      : "Ho cliccato «Rispondi» ma non sono riuscito a scrivere nel riquadro.",
  };
}

export type EsitoPerSede = {
  trovata: boolean;
  scritto: boolean;
  /** La radice (pagina o iframe) dove sta il riquadro: serve per pubblicare. */
  root: Radice | null;
  dettaglio: string;
};

/**
 * Flusso PER-SEDE completo: cerca la sede (nomeGoogle), apre le sue recensioni,
 * trova il cliente e — se `testo` c'è — scrive la bozza nel «Rispondi». NON
 * pubblica: la pubblicazione la decide il chiamante usando la `root` ritornata.
 * Usa la scheda `page` passata (ci naviga sopra).
 */
export async function rispondiPerSede(
  page: Page,
  nomeGoogle: string,
  nomeCliente: string,
  testo: string,
  opts: { log?: (m: string) => void } = {},
): Promise<EsitoPerSede> {
  const log = opts.log ?? (() => {});

  const sede = await apriSedePerNome(page, nomeGoogle, { log });
  if (!sede.aperta || !sede.root) {
    return { trovata: false, scritto: false, root: null, dettaglio: `sede «${nomeGoogle}»: ${sede.dettaglio}` };
  }
  const root = sede.root;

  const t = await cercaClienteNelleRecensioni(root, nomeCliente, { log });
  if (!t.trovata) {
    return { trovata: false, scritto: false, root, dettaglio: `sede «${nomeGoogle}»: ${t.dettaglio}` };
  }

  const r = await rispondiAllaRecensione(root, nomeCliente, testo, { log });
  return {
    trovata: true,
    scritto: r.scritto,
    root,
    dettaglio: `sede «${nomeGoogle}» · ${r.dettaglio}`,
  };
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
