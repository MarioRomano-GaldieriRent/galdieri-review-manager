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
      // Dal form il testo arriva con «\r\n», e la tastiera batte Invio per
      // ENTRAMBI i caratteri: righe vuote doppie nella risposta pubblicata.
      await pg.keyboard.type(testo.replace(/\r\n?/g, "\n"), { delay: 15 }).catch(() => {});
      via = `${nome} (trovati ${c})`;
      break;
    }
  }

  await pg.waitForTimeout(400);
  const invia = await bottoneInviaRisposta(root);
  const abilitato = invia ? await invia.isEnabled().catch(() => true) : false;
  return { scritto: via !== "nessuno", via, abilitato };
}

/**
 * Il bottone che INVIA/PUBBLICA la risposta scritta. Cambia con la UI:
 *  - business.google.com (gruppi): «Pubblica risposta»;
 *  - overlay di Google Search (per-sede): è di nuovo «Rispondi», il pulsante blu
 *    DENTRO il riquadro, accanto ad «Annulla». Da non confondere col «Rispondi»
 *    delle ALTRE recensioni (che aprirebbe il loro riquadro): quello giusto è
 *    l'unico sulla stessa riga di «Annulla».
 */
async function bottoneInviaRisposta(root: Radice): Promise<Locator | null> {
  const pub = root.getByRole("button", { name: /Pubblica risposta/i }).first();
  if ((await pub.count().catch(() => 0)) > 0 && (await pub.isVisible().catch(() => false))) {
    return pub;
  }

  /**
   * Il «Rispondi» sulla STESSA RIGA di un riferimento (il più vicino a lui).
   * Serve a distinguere il submit del riquadro dai «Rispondi» delle ALTRE
   * recensioni, che aprirebbero il loro riquadro invece di inviare.
   */
  const rispondiSullaRigaDi = async (
    rif: Locator,
    soloASinistra: boolean,
  ): Promise<Locator | null> => {
    // Timeout corto: un riferimento che non c'è costerebbe 30 secondi di
    // attesa a vuoto, e qui siamo nel mezzo della pubblicazione.
    const rBox = await rif.boundingBox({ timeout: 1500 }).catch(() => null);
    if (!rBox) return null;
    const rispondi = root.getByRole("button", { name: /^rispondi$/i });
    const n = await rispondi.count().catch(() => 0);
    let best: Locator | null = null;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const b = rispondi.nth(i);
      const box = await b.boundingBox({ timeout: 1500 }).catch(() => null);
      if (!box) continue;
      const dy = Math.abs(box.y - rBox.y);
      if (dy >= 40) continue;
      if (soloASinistra && box.x >= rBox.x + 5) continue;
      const d = Math.abs(rBox.x - box.x) + dy;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  };

  // Overlay per-sede: il submit «Rispondi» è quello accanto ad «Annulla», alla
  // sua sinistra (stessa riga).
  const conAnnulla = await rispondiSullaRigaDi(
    root.getByRole("button", { name: /^Annulla$/i }).first(),
    true,
  );
  if (conAnnulla) return conAnnulla;

  // Coda «Rispondere a recensioni»: lì un «Annulla» non c'è, e il submit sta
  // sulla stessa riga di «Ignora». Si accetta SOLO se il campo della coda è
  // davvero a schermo: senza quel vincolo, in una lista qualunque si rischiava
  // di scambiare per submit il «Rispondi» di un'altra recensione.
  // Qui si sta per CLICCARE un invio: prima bisogna essere sicuri di stare
  // davvero nella coda, non su una lista con un banner «Ignora» aperto. Si
  // pretendono tutti e tre i segni della coda, e VISIBILI — contare non basta,
  // perché Google tiene nel DOM anche i pezzi della vista che non guardi.
  const visibile = async (loc: Locator): Promise<boolean> => {
    const quanti = Math.min(await loc.count().catch(() => 0), 6);
    for (let i = 0; i < quanti; i++) {
      if (
        await loc
          .nth(i)
          .isVisible()
          .catch(() => false)
      )
        return true;
    }
    return false;
  };
  // Il campo della coda, dal vivo, NON ha un placeholder: ha un'etichetta
  // flottante (aria-label «La tua risposta pubblica»). Pretendere il
  // placeholder voleva dire non riconoscere MAI la coda vera al momento di
  // inviare: la risposta veniva scritta e poi «bottone di invio non trovato».
  const campoDellaCoda =
    (await visibile(root.getByPlaceholder(/Risposta pubblica|La tua risposta/i))) ||
    (await visibile(root.getByRole("textbox", { name: /rispost|risposta/i }))) ||
    (await visibile(root.locator("textarea")));
  const segniDellaCoda =
    campoDellaCoda &&
    (await visibile(root.getByRole("button", { name: /^Ignora$/i }))) &&
    (await visibile(root.getByText(/\d+\s*di\s*\d+/i)));
  if (!segniDellaCoda) return null;
  // Il riferimento dev'essere l'«Ignora» VISIBILE della coda: il primo del DOM
  // può essere quello nascosto di un banner rimasto nella lista, e allora non
  // si troverebbe più niente.
  const ignore = root.getByRole("button", { name: /^Ignora$/i });
  const quantiIgnora = Math.min(await ignore.count().catch(() => 0), 6);
  for (let i = 0; i < quantiIgnora; i++) {
    const c = ignore.nth(i);
    if (await c.isVisible({ timeout: 1500 }).catch(() => false)) {
      return rispondiSullaRigaDi(c, false);
    }
  }
  return null;
}

/** Invia/pubblica la risposta scritta (clicca il bottone giusto secondo la UI). */
export async function pubblica(root: Radice): Promise<void> {
  const b = await bottoneInviaRisposta(root);
  if (!b) {
    throw new Error(
      "bottone di invio non trovato (né «Pubblica risposta» né «Rispondi» accanto ad «Annulla»).",
    );
  }
  await b.scrollIntoViewIfNeeded().catch(() => {});
  await b.click({ timeout: 8000 });
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

/**
 * Versione del riconoscimento sulla LISTA (per sede e gruppi): stampata nel
 * passo-passo, così una build vecchia sul server si vede subito.
 */
export const VERSIONE_LISTA = "lista-1";

/** Una card di recensione letta dalla lista (pagina o iframe). */
export type CardLetta = {
  /** Indice con cui la card (e il suo «Rispondi») sono marcati nel DOM. */
  i: number;
  /** L'autore, dal link al profilo del recensore; "" se la vista non lo espone. */
  autore: string;
  /** Tutto il testo della card, icone escluse. */
  testo: string;
  stelle: string;
  /** Ha un «Rispondi» suo (cioè non ha ancora una risposta). */
  haRispondi: boolean;
};

/**
 * Legge le CARD delle recensioni in vista. Ogni card parte dal LINK AL PROFILO
 * del recensore (è lì che sta il nome) e sale agli antenati finché il
 * sottoalbero ne contiene uno solo — e un solo «Rispondi», e una sola riga di
 * stelle: quella è la sua card. Se la vista non ha link ai profili, si parte
 * dai controlli «Rispondi» (testo ESATTO, non «Rispondere a recensioni») e
 * l'autore resta vuoto: si potrà riconoscere solo dal testo.
 * Marca ogni card con `data-robot-card` e il suo «Rispondi» con
 * `data-robot-rispondi-di`: il click lo fa poi Playwright, coi suoi controlli.
 */
async function leggiCards(root: Radice): Promise<{ cards: CardLetta[]; errore: string }> {
  try {
    const cards = await root.evaluate(() => {
      // ATTENZIONE: NIENTE funzioni con nome qui dentro (`const f = () => …`):
      // tsx/esbuild le avvolge in `__name(…)`, che nel browser non esiste, e
      // la evaluate salta. Era il motivo per cui il vecchio aggancio «per
      // card» falliva in silenzio e lasciava il posto a quello per geometria.
      document.querySelectorAll("[data-robot-card]").forEach((e) => e.removeAttribute("data-robot-card"));
      document
        .querySelectorAll("[data-robot-rispondi-di]")
        .forEach((e) => e.removeAttribute("data-robot-rispondi-di"));

      // I «Rispondi» veri e VISIBILI. Quello accanto ad «Annulla» è il submit
      // di un riquadro già aperto, non quello di una card: fuori.
      const rispondi: Element[] = [];
      for (const el of Array.from(document.querySelectorAll("button, a, [role=button]"))) {
        const box = el.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const a = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!(t === "rispondi" || /^rispondi\b/.test(a))) continue;
        let accantoAdAnnulla = false;
        const riga = el.parentElement;
        if (riga) {
          for (const b of Array.from(riga.querySelectorAll("button, [role=button]"))) {
            if ((b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "annulla") accantoAdAnnulla = true;
          }
        }
        if (!accantoAdAnnulla) rispondi.push(el);
      }

      // I link ai profili, VISIBILI. Si contano per profilo (href), perché in
      // una card lo stesso link può comparire due volte (foto + nome).
      const link: Element[] = [];
      for (const el of Array.from(document.querySelectorAll('a[href*="/maps/contrib/"], a[jsname="xs1xe"]'))) {
        const box = el.getBoundingClientRect();
        if (box.width >= 2 && box.height >= 2) link.push(el);
      }
      const stelle: Element[] = Array.from(
        document.querySelectorAll('[role="img"][aria-label*="stell" i], [role="img"][aria-label*="star" i]'),
      );

      // Da dove si parte: dai link (autore leggibile) o, se non ce ne sono,
      // dai «Rispondi» (autore vuoto).
      const semi: Element[] = link.length > 0 ? link : rispondi;
      const esito: { i: number; autore: string; testo: string; stelle: string; haRispondi: boolean }[] = [];
      const gia: Element[] = [];
      for (const seme of semi) {
        let card: Element = seme;
        for (let salite = 0; salite < 14; salite++) {
          const su = card.parentElement;
          if (!su || su === document.body) break;
          const profili: string[] = [];
          for (const l of link) {
            if (!su.contains(l)) continue;
            const h = l.getAttribute("href") || "";
            if (profili.indexOf(h) < 0) profili.push(h);
          }
          let quantiRispondi = 0;
          for (const r of rispondi) if (su.contains(r)) quantiRispondi++;
          let quanteStelle = 0;
          for (const s of stelle) if (su.contains(s)) quanteStelle++;
          if (profili.length > 1 || quantiRispondi > 1 || quanteStelle > 1) break;
          card = su;
        }
        if (card === seme) continue; // nessun contenitore: non è una card
        if (gia.indexOf(card) >= 0) continue; // stessa card raggiunta da due semi
        gia.push(card);

        const copia = card.cloneNode(true) as HTMLElement;
        copia
          .querySelectorAll('i, svg, [aria-hidden="true"], .google-symbols, .notranslate')
          .forEach((e) => e.remove());
        const linkAutore = copia.querySelector('a[href*="/maps/contrib/"], a[jsname="xs1xe"]');
        const autore = (linkAutore ? linkAutore.textContent || "" : "").replace(/\s+/g, " ").trim();
        const testo = (copia.textContent || "").replace(/\s+/g, " ").trim();
        let etichettaStelle = "";
        for (const s of stelle) {
          if (card.contains(s)) {
            etichettaStelle = (s.getAttribute("aria-label") || "").trim();
            break;
          }
        }
        let suoRispondi: Element | null = null;
        for (const r of rispondi) {
          if (card.contains(r)) {
            suoRispondi = r;
            break;
          }
        }
        const i = esito.length;
        card.setAttribute("data-robot-card", String(i));
        if (suoRispondi) suoRispondi.setAttribute("data-robot-rispondi-di", String(i));
        esito.push({ i, autore, testo, stelle: etichettaStelle, haRispondi: suoRispondi !== null });
      }
      return esito;
    });
    return { cards, errore: "" };
  } catch (e) {
    return { cards: [], errore: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/**
 * Fra le card lette, QUELLA del cliente — con le stesse regole della coda
 * (`stessoContenuto`, `eSuaLaRecensione`), MAI per sottostringa del nome:
 *  - se c'è il testo della recensione comanda il testo: dev'esserci UNA card
 *    che lo contiene. Se nessuna lo contiene, non ci si fida del solo nome
 *    (con «D» vorrebbe dire scegliere un altro «D»);
 *  - senza testo (5★ secche), l'autore dev'essere IDENTICO e UNICO: due
 *    omonimi senza niente per distinguerli non si toccano.
 * Chi non è sicuro non sceglie: meglio «non trovata» che pubblicare sotto la
 * recensione di un estraneo.
 */
function scegliCard(
  cards: CardLetta[],
  nome: string,
  testoRecensione: string,
): { card: CardLetta | null; motivo: string } {
  const testo = testoRecensione.trim();
  const conTesto = ridotto(testo).length >= 12;
  const suoAutore = (c: CardLetta) => c.autore !== "" && eSuaLaRecensione(c.autore, nome);
  // Per autore contano solo le card ANCORA SENZA risposta: a quelle con la
  // risposta non si potrebbe comunque rispondere, e la coda di Google mostra
  // solo le prime. Così una sua recensione vecchia, già risposta, non rende
  // «ambigua» quella nuova.
  const perAutore = cards.filter((c) => c.haRispondi && suoAutore(c));
  const perAutoreTutte = cards.filter(suoAutore);
  const giaRisposte = perAutoreTutte.length - perAutore.length;
  if (conTesto) {
    const perTesto = cards.filter((c) => stessoContenuto(c.testo, testo));
    if (perTesto.length === 1) {
      const c = perTesto[0];
      const autoreOk = c.autore ? eSuaLaRecensione(c.autore, nome) : combaciaNome(c.testo, nome);
      return {
        card: c,
        motivo: autoreOk
          ? "combacia il testo della recensione e l'autore"
          : `combacia il testo della recensione (l'autore a schermo è «${c.autore || "?"}», non «${nome}»: mi fido del testo)`,
      };
    }
    if (perTesto.length > 1) {
      return { card: null, motivo: `${perTesto.length} card contengono lo stesso testo: non scelgo` };
    }
    return {
      card: null,
      motivo: `nessuna card col testo della recensione${
        perAutoreTutte.length > 0
          ? ` (${perAutoreTutte.length} con l'autore «${nome}» ma un testo diverso: non mi fido del solo nome)`
          : ""
      }`,
    };
  }
  if (perAutore.length === 1) {
    return {
      card: perAutore[0],
      motivo: `combacia l'autore (nessun testo da confrontare)${
        giaRisposte > 0 ? `; un'altra sua ha già la risposta` : ""
      }`,
    };
  }
  if (perAutore.length > 1) {
    return {
      card: null,
      motivo: `${perAutore.length} recensioni senza risposta con l'autore «${nome}» e nessun testo per distinguerle: non scelgo`,
    };
  }
  if (giaRisposte > 0) {
    return {
      card: null,
      motivo: `l'unica recensione con l'autore «${nome}» ha già una risposta`,
    };
  }
  const simili = cards.filter((c) => combaciaNome(c.autore, nome) || combaciaNome(c.testo, nome)).length;
  return {
    card: null,
    motivo: `nessuna card con l'autore «${nome}»${
      simili > 0 ? ` (${simili} lo contengono o gli somigliano, ma non è lo stesso nome)` : ""
    }`,
  };
}

/**
 * La card del cliente nella vista corrente: legge le card, sceglie con
 * `scegliCard`, la porta in vista. `rispondi` è il locator del SUO «Rispondi»
 * (null se la card ha già una risposta, o se non è stata scelta).
 */
async function cardDelCliente(
  root: Radice,
  nome: string,
  testoRecensione: string,
  log: (m: string) => void,
): Promise<{ card: CardLetta | null; rispondi: Locator | null; dettaglio: string }> {
  const { cards, errore } = await leggiCards(root);
  if (errore) return { card: null, rispondi: null, dettaglio: `lettura delle card fallita: ${errore}` };
  log(
    `card in vista (${VERSIONE_LISTA}): ${cards.length}${
      cards.length > 0
        ? " — " +
          cards
            .slice(0, 12)
            .map((c) => `«${c.autore || "?"}»${c.haRispondi ? "" : " (già risposta)"}`)
            .join(", ")
        : ""
    }`,
  );
  const scelta = scegliCard(cards, nome, testoRecensione);
  if (!scelta.card) return { card: null, rispondi: null, dettaglio: scelta.motivo };
  const c = scelta.card;
  log(
    `card di «${nome}»: autore «${c.autore || "?"}»${c.stelle ? " · " + c.stelle : ""} · «${c.testo.slice(0, 120)}…» — ${scelta.motivo}.`,
  );
  await root
    .locator(`[data-robot-card="${c.i}"]`)
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  const rispondi = c.haRispondi ? root.locator(`[data-robot-rispondi-di="${c.i}"]`).first() : null;
  return { card: c, rispondi, dettaglio: scelta.motivo };
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
export async function cercaInPaginaCorrente(
  page: Page,
  nome: string,
  testo: string,
  opts: { testoRecensione?: string; log?: (m: string) => void } = {},
): Promise<EsitoMatch> {
  const log = opts.log ?? (() => {});
  await page
    .getByRole("button", { name: /Rispondi/i })
    .first()
    .waitFor({ timeout: 12000 })
    .catch(() => {});

  // Per card, con le regole della coda. Prima si prendeva la PRIMA occorrenza
  // del nome come sottostringa e il «Rispondi» più vicino sotto: con «D»
  // combaciava con mezza pagina e si rispondeva a un altro — in modalità
  // reale, pubblicando.
  let ultimo = "";
  for (let s = 0; s < 3; s++) {
    const c = await cardDelCliente(page, nome, opts.testoRecensione ?? "", log);
    if (c.card) {
      if (!c.rispondi) {
        return {
          trovata: true,
          scritto: false,
          dettaglio: `«${nome}» trovato (${c.dettaglio}), ma la sua card non ha «Rispondi»: ha già una risposta.`,
        };
      }
      await c.rispondi.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const r = await scriviRisposta(page, testo);
      return {
        trovata: true,
        scritto: r.scritto,
        dettaglio: `${c.dettaglio} · campo: ${r.via} · «Pubblica» abilitato: ${r.abilitato}`,
      };
    }
    ultimo = c.dettaglio;
    // Non ancora: scroll corto per far rendere il resto di QUESTA pagina.
    if (s < 2) {
      await scrollaGiu(page, 900);
      await page.waitForTimeout(600);
    }
  }
  return { trovata: false, scritto: false, dettaglio: `non in questa pagina (${ultimo})` };
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
  opts: { maxPagine?: number; log?: (m: string) => void; testoRecensione?: string } = {},
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
      const e = await cercaInPaginaCorrente(s.page, nome, testo, {
        testoRecensione: opts.testoRecensione,
        log,
      });
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
  opts: { maxPassi?: number; log?: (m: string) => void; testoRecensione?: string } = {},
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
    const nRisp = await contaRispondi(root);
    // Per card, con le regole della coda. MAI «il nome compare da qualche
    // parte»: con un recensore chiamato «D» quel conteggio era sempre > 0 e
    // si dichiarava «trovato» al primo passo, su chiunque.
    const c = await cardDelCliente(root, nome, opts.testoRecensione ?? "", log);
    log(`passo ${s + 1}: ${c.card ? "trovata" : c.dettaglio} · recensioni visibili = ${nRisp}`);

    if (c.card) {
      await pg.waitForTimeout(400);
      return {
        trovata: true,
        dettaglio: `«${nome}» trovato al passo ${s + 1} (${c.dettaglio}) e portato in vista (non toccato).`,
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
  opts: { log?: (m: string) => void; testoRecensione?: string } = {},
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
    return trovaRecensioneNellaLista(root, nome, { log, testoRecensione: opts.testoRecensione });
  }

  await campo.click().catch(() => {});
  await campo.fill("").catch(() => {});
  await pg.keyboard.type(nome, { delay: 30 }).catch(() => {});
  await pg.keyboard.press("Enter").catch(() => {});
  log(`scritto «${nome}» nel campo di ricerca delle recensioni`);
  await pg.waitForTimeout(3000);
  await scatto("6-cerca-cliente");

  const nRisp = await contaRispondi(root);
  // Fra i risultati, la SUA card con le regole della coda — non «il nome
  // compare da qualche parte», che con «D» era vero su qualunque pagina.
  const c = await cardDelCliente(root, nome, opts.testoRecensione ?? "", log);
  if (c.card) {
    await scatto("7-cliente");
    return {
      trovata: true,
      dettaglio: `«${nome}» filtrato con la ricerca delle recensioni (${nRisp} risultati visibili): ${c.dettaglio}.`,
    };
  }
  await scatto("7-cliente");
  return {
    trovata: false,
    dettaglio: `Ho cercato «${nome}» nelle recensioni: ${c.dettaglio} (${nRisp} risultati). Vedi gli screenshot 6 e 7.`,
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
  opts: { log?: (m: string) => void; testoRecensione?: string } = {},
): Promise<EsitoRisposta> {
  const log = opts.log ?? (() => {});
  const nome = nomeCliente.trim();
  const pg = paginaDi(root);
  const scatto = async (tag: string) => {
    const p = path.join(SCREENSHOT_DIR, `prova-sede-${tag}.png`);
    await pg.screenshot({ path: p }).catch(() => {});
    log(`screenshot: ${p}`);
  };

  // La SUA card, con le regole della coda (testo della recensione, o autore
  // identico e unico): mai per sottostringa del nome.
  const suaCard = await cardDelCliente(root, nome, opts.testoRecensione ?? "", log);
  if (!suaCard.card) {
    return {
      scritto: false,
      via: "nessun-nome",
      abilitato: false,
      dettaglio: `«${nome}» non è nella lista (${suaCard.dettaglio}): va cercato prima.`,
    };
  }
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

  // Il «Rispondi» DELLA SUA card, marcato dalla lettura delle card. Niente più
  // ripiego «per geometria» (il «Rispondi» più vicino sotto la prima
  // occorrenza del nome): con un nome di una lettera agganciava la card di un
  // altro, e in modalità reale ci si pubblicava sopra.
  const rispondi = suaCard.rispondi;
  if (!rispondi) {
    return {
      scritto: false,
      via: "nessun-rispondi",
      abilitato: false,
      dettaglio: `Trovato «${nome}» (${suaCard.dettaglio}) ma la sua card non ha «Rispondi»: ha già una risposta. NON ho cliccato niente. Guarda 8a e la riga «bottoni».`,
    };
  }
  log(`aggancio il «Rispondi» della card di «${nome}» (${suaCard.dettaglio}).`);
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

export type EsitoCodaIgnora = {
  trovata: boolean;
  scritto: boolean;
  dettaglio: string;
  /** Un rigo per passo: cosa ha trovato/cliccato, in ordine. Sempre presente,
   * anche quando fallisce — è la diagnostica che serve per calibrare i
   * selettori senza dover leggere gli screenshot sul server. */
  passi: string[];
  /** La radice della coda dove sta il riquadro: serve a chi poi pubblica. */
  root?: Radice | null;
  /** L'autore letto sulla recensione dove si è scritto: la PROVA del match. */
  autore?: string;
};

/**
 * Sigla della versione del metodo, stampata come PRIMO rigo del passo-passo: se
 * nel log sul server non compare questa sigla, il codice in esecuzione è quello
 * vecchio (manca «npm run build» + restart dopo il git pull) e non serve
 * cercare il problema altrove.
 */
export const VERSIONE_CODA = "coda-12";

/** Minuscolo, senza accenti, spazi normalizzati: per confrontare i nomi. */
function senzaAccenti(x: string): string {
  return x
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Apostrofi e trattini «tipografici»: Google li rende come li ha scritti
    // chi recensisce, il database no. Senza questo «D'Angelo» e «D’Angelo»
    // sarebbero due persone diverse e la coda non troverebbe mai la sua.
    .replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Il nome compare nel testo come PAROLA INTERA. Il confronto «contiene» non va
 * bene: molti recensori Google hanno un nome cortissimo (perfino una sola
 * lettera, «D»), e cercandolo come sottostringa combaciava con mezza pagina —
 * era il motivo per cui il robot scriveva sulla recensione sbagliata.
 */
function combaciaNome(testo: string, nome: string): boolean {
  const t = senzaAccenti(testo);
  const q = senzaAccenti(nome);
  if (!q || !t) return false;
  const fuggito = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${fuggito}([^\\p{L}\\p{N}]|$)`, "u").test(t);
}

/** Solo lettere e numeri, per confrontare due testi ignorando la forma. */
function ridotto(x: string): string {
  return senzaAccenti(x)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DECIDE se l'autore mostrato è DAVVERO la persona cercata. Qui il «contiene»
 * di combaciaNome non basta e sarebbe pericoloso: col cliente «D» combacia con
 * «Vito D'Amico», «D'Angelo Vincenzo», «Maria D. Rossi» — e su quella strada si
 * pubblicherebbe, per sempre, sotto la recensione di un estraneo. Serve
 * un'UGUAGLIANZA.
 *
 * Unica tolleranza, e solo per nomi lunghi di almeno due parole: l'autore può
 * avere qualcosa in più in coda («Mario Rossi G.»), mai in meno e mai diverso
 * («Mario Rossini» non è «Mario Rossi»). Un nome di una o due lettere dev'essere
 * identico e basta.
 */
function eSuaLaRecensione(autore: string, nome: string): boolean {
  const a = ridotto(autore.split("·")[0]); // via «· Local Guide · N recensioni»
  const q = ridotto(nome);
  if (!a || !q) return false;
  if (a === q) return true;
  const tq = q.split(" ");
  const ta = a.split(" ");
  if (q.length < 3 || tq.length < 2) return false;
  return tq.length < ta.length && tq.every((x, i) => x === ta[i]);
}

/**
 * Il CONTENUTO mostrato è quello che stiamo cercando? È la prova più forte che
 * ci sia: due persone possono chiamarsi uguale — o chiamarsi «D» — ma non
 * scrivono la stessa recensione. Si confronta il testo salvato nel database con
 * quello a schermo, ridotti entrambi a sole lettere e numeri, perché Google
 * manda a capo, cambia la punteggiatura e aggiunge le sue righe («Tradotto da
 * Google»): un confronto letterale non reggerebbe.
 *
 * Le recensioni lunghe vengono mostrate tagliate con «Altro»: in quel caso
 * basta che l'inizio combaci, purché sia un pezzo abbastanza lungo da non
 * poter capitare per caso.
 */
function stessoContenuto(testoCarta: string, testoAtteso: string): boolean {
  const a = ridotto(testoCarta);
  const q = ridotto(testoAtteso);
  if (q.length < 12) return false; // troppo corto per essere una prova
  if (a.includes(q)) return true;
  const pezzo = q.slice(0, 60);
  return pezzo.length >= 30 && a.includes(pezzo);
}

/**
 * METODO DELLA CODA: invece di scorrere la lista intera della sede, si entra
 * nella coda di Google «Rispondere a recensioni» — le sole recensioni ancora
 * SENZA risposta, UNA alla volta, col contatore «N di TOT recensioni» — e si
 * preme «Ignora» per passare alla successiva finché non compare quella cercata.
 * In una sede con centinaia di recensioni è molto più diretto.
 *
 * Vista CONFERMATA dal vivo: nella coda il campo «Risposta pubblica» è GIÀ
 * APERTO per la recensione mostrata (non c'è un «Rispondi» da cliccare prima,
 * a differenza dell'overlay per-sede). Il «Rispondi» in basso è il pulsante che
 * INVIA, e sta sulla stessa riga di «Ignora».
 *
 * Le lezioni pagate dal vivo, e perché il codice è fatto così:
 *  1. il tasto della coda NON è detto che stia nello stesso contesto DOM della
 *     lista: si cerca in TUTTI — pagina e ogni iframe;
 *  2. un click può fallire in silenzio, e gli indizi della coda («Ignora», un
 *     «N di M») esistono anche sulla LISTA: entrare va verificato come un
 *     CAMBIAMENTO dopo il click — più indizi di prima — non dedotto dall'aver
 *     cliccato né da una lettura fatta prima di cliccare;
 *  3. il nome va confrontato con l'AUTORE della recensione mostrata, dentro il
 *     suo riquadro, non cercato in tutta la pagina: così si preme «Ignora»
 *     finché non compare davvero la sua, che è il modo in cui il metodo
 *     funziona a mano;
 *  4. chi guarda ha bisogno del passo-passo SEMPRE: a ogni salto si registra
 *     l'autore visto, così dal log si capisce cosa stava guardando il robot.
 *
 * `uscita` decide come si esce una volta scritto:
 *   - "sicura"  → svuota il campo ed esce con «Ignora»: non lascia traccia.
 *   - "ferma"   → scrive e SI FERMA lì, senza toccare altro: la recensione
 *                 resta a schermo con la risposta pronta, perché una persona
 *                 possa controllare che sia davvero quella giusta. Non
 *                 pubblica e non scarta: decide chi guarda.
 *   - "lascia"  → come "ferma", ma restituisce `root` perché la
 *                 pubblicazione la faccia il chiamante (tasto «Rispondi»).
 *
 * `scadenza` (timestamp ms) è il momento oltre il quale si smette di saltare e
 * si torna comunque con l'esito: meglio un passo-passo leggibile che il timeout
 * muto di chi aspetta.
 *
 * Presuppone la sede GIÀ APERTA. Non clicca MAI da sé il pulsante d'invio.
 */
export async function cercaNellaCoda(
  root: Radice,
  nomeCliente: string,
  testo: string,
  opts: {
    maxIgnora?: number;
    log?: (m: string) => void;
    scadenza?: number;
    uscita?: "sicura" | "lascia" | "ferma";
    /**
     * Il testo della recensione come sta nel database: è il modo più sicuro di
     * riconoscerla: i nomi si ripetono e possono essere una sola lettera, il
     * testo no. Se manca, si va di solo autore (regola stretta).
     */
    testoRecensione?: string;
  } = {},
): Promise<EsitoCodaIgnora> {
  const maxIgnora = opts.maxIgnora ?? 40;
  const log = opts.log ?? (() => {});
  const scadenza = opts.scadenza ?? Number.POSITIVE_INFINITY;
  const uscita = opts.uscita ?? "sicura";
  const testoAtteso = (opts.testoRecensione ?? "").trim();
  const nome = nomeCliente.trim();
  const pg = paginaDi(root);
  const passi: string[] = [];
  const annota = (m: string) => {
    passi.push(m);
    log(m);
  };
  const scaduto = () => Date.now() > scadenza;
  const perche = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

  annota(
    `metodo coda «Ignora», versione ${VERSIONE_CODA}, uscita «${uscita}», riconoscimento: ${testoAtteso ? "testo della recensione + autore" : "solo autore"}.`,
  );

  /**
   * TUTTI i contesti DOM in cui il controllo può stare: la radice ricevuta, la
   * pagina, e ogni iframe. Cercare solo nella radice della lista era il difetto
   * del primo giro: il tasto della coda può stare fuori da quel frame.
   */
  const radici = (): Radice[] => {
    const viste = new Set<Radice>();
    const out: Radice[] = [];
    for (const r of [root, pg as Radice, ...pg.frames().filter((f) => f !== pg.mainFrame())]) {
      if (!r || viste.has(r)) continue;
      viste.add(r);
      out.push(r);
    }
    return out;
  };
  const nomeRadice = (r: Radice): string => {
    if (r === pg) return "pagina";
    if (r === root) return "radice-recensioni";
    return `iframe ${(r as Frame).url().replace(/^https?:\/\//, "").slice(0, 50)}`;
  };

  /** I controlli VERI visibili ora, contesto per contesto: la calibrazione. */
  const etichetteDi = (r: Radice): Promise<string[]> =>
    r
      .locator("button, [role=button], [role=tab], a")
      .evaluateAll((els) =>
        els
          .filter((e) => (e as HTMLElement).offsetParent !== null)
          .map((e) =>
            (e.textContent || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
          )
          .filter((t) => t && t.length < 60),
      )
      .catch(() => [] as string[]);

  const fotografaControlli = async (etichetta: string) => {
    for (const r of radici()) {
      const e = await etichetteDi(r);
      annota(`${etichetta} · ${nomeRadice(r)}: ${JSON.stringify([...new Set(e)].slice(0, 25))}`);
    }
  };

  // Chi ha aperto la sede ha già scorso la lista verso il BASSO per far
  // caricare le recensioni: il tasto della coda sta in alto, quindi si risale.
  for (const r of radici()) await scrollaGiu(r, -4000);
  await pg.waitForTimeout(700);
  await fotografaControlli("controlli prima di entrare");

  /**
   * Riconoscere la coda: NON basta un indizio solo. Su Business Profile
   * «Ignora» è anche l'etichetta con cui si chiudono i banner, e un «N di M»
   * può essere il pager della lista: presi in OR facevano scambiare la LISTA
   * per la coda, e allora il tasto «Rispondere a recensioni» non veniva più
   * cliccato. Qui si contano tre indizi separati e si registra il punteggio,
   * senza pretendere che stiano tutti nello stesso frame — dal vivo si è visto
   * che possono essere sparsi.
   */
  /**
   * Il primo elemento VISIBILE fra quelli che combaciano. Contarli non basta:
   * l'interfaccia di Google tiene nel DOM anche i pezzi NASCOSTI della vista
   * che non stai guardando, quindi il campo di risposta e l'«Ignora» della coda
   * risultavano presenti già mentre eri sulla lista — gli indizi erano accesi
   * prima ancora di cliccare, e il cambiamento non si vedeva mai.
   */
  const primoVisibile = async (loc: Locator, max = 6): Promise<Locator | null> => {
    const n = Math.min(await loc.count().catch(() => 0), max);
    for (let i = 0; i < n; i++) {
      const c = loc.nth(i);
      if (await c.isVisible({ timeout: 1500 }).catch(() => false)) return c;
    }
    return null;
  };

  const etichettaIgnora = /^ignora$|^ignore$|^salta$|^skip$/i;
  const contatoreCoda = /\d+\s*di\s*\d+/i;
  const campoRisposta = /Risposta pubblica|La tua risposta|Rispondi a|Scrivi/i;
  /**
   * Tutti i modi in cui può presentarsi il riquadro dove si scrive. Fidarsi del
   * solo placeholder era troppo poco: se non combaciava, il metodo non riusciva
   * a isolare la recensione e si fermava PRIMA di premere «Ignora».
   */
  const campiDiRisposta = (r: Radice): Locator =>
    r
      .getByPlaceholder(campoRisposta)
      .or(r.getByRole("textbox", { name: /rispost|risposta/i }))
      .or(r.locator("textarea"))
      .or(r.locator('[contenteditable="true"]'));

  /**
   * Il tasto «Ignora» della coda. Dal vivo è un <button> col testo dentro uno
   * span annidato, quindi il nome accessibile è «Ignora»: si cerca per ruolo e,
   * per sicurezza, anche fra i <button> il cui testo è solo quello.
   */
  const tastoIgnora = (r: Radice): Locator =>
    r
      .getByRole("button", { name: etichettaIgnora })
      .or(r.locator("button").filter({ hasText: /^\s*(ignora|ignore|salta|skip)\s*$/i }));
  type Segnali = { punti: number; radice: Radice | null; descrizione: string };
  const leggiSegnali = async (): Promise<Segnali> => {
    let radice: Radice | null = null;
    const visti: string[] = [];
    let punti = 0;

    for (const r of radici()) {
      const b = await primoVisibile(tastoIgnora(r));
      if (b && (await b.isEnabled({ timeout: 1500 }).catch(() => false))) {
        punti++;
        radice = radice ?? r;
        visti.push(`«Ignora» attivo (${nomeRadice(r)})`);
        break;
      }
    }

    // Contatore: vale solo se la parola «recensioni» sta ATTACCATA al numero
    // (nell'elemento stesso o in quello che lo contiene). Cercarla in tutta la
    // radice non serviva a niente: in una pagina di recensioni c'è ovunque.
    // Si scartano anche gli intervalli tipo «1-10 di 348», che sono pager.
    for (const r of radici()) {
      const c = await primoVisibile(r.getByText(contatoreCoda));
      if (!c) continue;
      const testoC = ((await c.textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (/\d\s*[-–]\s*\d+\s*di/i.test(testoC)) continue; // «1-10 di 348»: è un pager
      const attorno = (
        (await c
          .locator("xpath=..")
          .textContent()
          .catch(() => "")) || ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (!/recension/i.test(testoC) && !/recension/i.test(attorno)) continue;
      punti++;
      radice = radice ?? r;
      visti.push(`contatore «${testoC.slice(0, 30)}» (${nomeRadice(r)})`);
      break;
    }

    for (const r of radici()) {
      if (await primoVisibile(campiDiRisposta(r))) {
        punti++;
        radice = radice ?? r;
        visti.push(`campo di risposta già aperto (${nomeRadice(r)})`);
        break;
      }
    }

    return {
      punti,
      radice,
      descrizione: visti.length ? `${punti}/3 — ${visti.join("; ")}` : "0/3 — nessun indizio",
    };
  };

  /**
   * Come si trova il tasto per ENTRARE nella coda. Cercarlo per «nome
   * accessibile» con una frase esatta non è bastato — e infatti, ripensandoci
   * col senno del log, non è mai stato cliccato: l'etichetta cambia
   * («Rispondere a recensioni», «Rispondi alle recensioni», spesso con un
   * contatore accanto) e a volte il testo è spezzato fra più elementi, così
   * getByRole non lo vedeva e getByText restituiva il contenitore grande.
   *
   * Qui si guarda il DOM vero: si prende l'elemento PIÙ PICCOLO il cui testo
   * (o aria-label) parla insieme di «rispond…» e «recension…», si sale al primo
   * antenato cliccabile e lo si MARCA con un attributo — poi il click lo fa
   * Playwright, con i suoi controlli di visibilità e scroll. È la stessa
   * tecnica già usata per il «Rispondi» della card giusta.
   */
  const marcaCandidati = (r: Radice): Promise<string[]> =>
    r
      .evaluate(() => {
        // ATTENZIONE: qui dentro NIENTE funzioni con nome (`const f = () => …`).
        // Il robot gira con tsx/esbuild, che le avvolge in `__name(…)`, e quel
        // wrapper NON esiste nel browser: la evaluate lancerebbe
        // «__name is not defined» — che è esattamente quello che succedeva, con
        // l'errore nascosto da un catch silenzioso. Tutto inline, quindi.
        document
          .querySelectorAll("[data-robot-coda]")
          .forEach((e) => e.removeAttribute("data-robot-coda"));
        const cliccabile = "button, a, [role=button], [role=tab], [role=link], [role=menuitem]";
        const scelti: { el: Element; testo: string }[] = [];
        const visti = new Set<Element>();
        for (const e of Array.from(document.querySelectorAll("*"))) {
          const box = e.getBoundingClientRect();
          if (box.width < 2 || box.height < 2) continue; // non a schermo
          const testo = (e.getAttribute("aria-label") || e.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          const t = testo.toLowerCase();
          const parla =
            t.length > 0 &&
            t.length <= 60 &&
            ((t.includes("rispond") && t.includes("recension")) ||
              (t.includes("reply") && t.includes("review")));
          if (!parla) continue;
          // Se un figlio combacia già, questo è solo il contenitore: si scende.
          let figlio = false;
          for (const c of Array.from(e.children)) {
            const tc = (c.getAttribute("aria-label") || c.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            if (
              tc.length > 0 &&
              tc.length <= 60 &&
              ((tc.includes("rispond") && tc.includes("recension")) ||
                (tc.includes("reply") && tc.includes("review")))
            ) {
              figlio = true;
              break;
            }
          }
          if (figlio) continue;
          const bersaglio = e.closest(cliccabile) || e;
          if (visti.has(bersaglio)) continue;
          visti.add(bersaglio);
          scelti.push({ el: bersaglio, testo });
          if (scelti.length >= 4) break;
        }
        scelti.forEach((o, i) => o.el.setAttribute("data-robot-coda", String(i)));
        return scelti.map((o) => o.el.tagName.toLowerCase() + ": " + o.testo.slice(0, 45));
      })
      // L'errore va DETTO, non inghiottito: nascosto qui dentro è costato due giri.
      .catch((e) => {
        annota(`lettura del DOM fallita in ${nomeRadice(r)}: ${perche(e)}`);
        return [] as string[];
      });

  // Lettura PRIMA di toccare qualsiasi cosa: serve solo come rumore di fondo.
  // NON è una scorciatoia per saltare il click — usarla così era il difetto:
  // un «Ignora» da banner sulla lista bastava a non cliccare mai la coda.
  const iniziali = await leggiSegnali();
  annota(`indizi di coda prima di cliccare: ${iniziali.descrizione}`);

  /**
   * Si è entrati davvero? Serve un CAMBIAMENTO rispetto a prima: o più indizi,
   * o indizi diversi con almeno due su tre. Il solo «più indizi» non basta,
   * perché il punteggio è limitato a 3: se la lista ne mostrava già tre, nessun
   * click avrebbe mai potuto farlo salire.
   */
  const entrato = (dopo: Segnali): boolean =>
    dopo.radice !== null &&
    (dopo.punti > iniziali.punti || (dopo.punti >= 2 && dopo.descrizione !== iniziali.descrizione));

  let coda: Radice | null = null;
  const urlPrima = pg.url();

  for (const r of radici()) {
    if (coda || scaduto()) break;
    const etichette = await marcaCandidati(r);
    if (etichette.length === 0) {
      annota(`nessun candidato «rispondere a recensioni» in ${nomeRadice(r)}.`);
      continue;
    }
    annota(`candidati in ${nomeRadice(r)}: ${JSON.stringify(etichette)}`);
    for (let i = 0; i < etichette.length && !coda; i++) {
      const c = r.locator(`[data-robot-coda="${i}"]`).first();
      if ((await c.count().catch(() => 0)) === 0) continue;
      await c.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await c.click({ timeout: 6000 });
        annota(`  cliccato il candidato ${i + 1} (${etichette[i]}).`);
      } catch (e) {
        annota(`  candidato ${i + 1} (${etichette[i]}): click FALLITO — ${perche(e)}`);
        continue;
      }
      await pg.waitForTimeout(2500);
      const dopo = await leggiSegnali();
      if (entrato(dopo)) {
        coda = dopo.radice;
        annota(`  sono entrato nella coda: ${dopo.descrizione}`);
      } else {
        annota(
          `  cliccato, ma la vista non è cambiata (${dopo.descrizione}; URL ${pg.url() === urlPrima ? "invariato" : "cambiato"}): provo il prossimo.`,
        );
      }
    }
  }

  // Rete di sicurezza: la vecchia ricerca per ruolo/etichetta, nel caso il
  // controllo non sia raggiungibile con la marcatura (per esempio se sta in un
  // frame che non si lascia interrogare).
  const etichettaCoda =
    /rispondere a recensioni|rispondi alle recensioni|reply to reviews|gestisci le risposte|manage responses/i;
  if (!coda && !scaduto()) {
    annota("nessun candidato ha aperto la coda: riprovo per ruolo/etichetta.");
    for (const r of radici()) {
      if (coda) break;
      for (const loc of [
        r.getByRole("button", { name: etichettaCoda }),
        r.getByRole("link", { name: etichettaCoda }),
        r.getByRole("tab", { name: etichettaCoda }),
      ]) {
        const c = loc.first();
        if ((await c.count().catch(() => 0)) === 0) continue;
        await c.scrollIntoViewIfNeeded().catch(() => {});
        await c.click({ timeout: 5000 }).catch(() => {});
        await pg.waitForTimeout(2500);
        const dopo = await leggiSegnali();
        if (entrato(dopo)) {
          coda = dopo.radice;
          annota(`entrato per ruolo/etichetta in ${nomeRadice(r)}: ${dopo.descrizione}`);
          break;
        }
      }
    }
  }

  // Ripiego per il caso legittimo: nessun tasto ha funzionato, ma gli indizi
  // erano già forti in partenza (2 su 3) — può darsi che fossimo GIÀ nella
  // coda. Si prosegue da lì, ma dicendo chiaramente che non è una certezza.
  if (!coda && iniziali.punti >= 2 && iniziali.radice) {
    if (uscita === "sicura") {
      coda = iniziali.radice;
      annota(`nessun tasto ha aperto la coda, ma gli indizi erano già forti (${iniziali.descrizione}): proseguo da qui, ingresso PRESUNTO — lo faccio solo perché è una prova che non pubblica.`);
    } else {
      // Di là si pubblica: un ingresso «presunto» vuol dire non sapere in che
      // vista si è e scrivere alla cieca. Meglio arrendersi e lasciare il
      // posto al ripiego collaudato.
      annota(`indizi forti (${iniziali.descrizione}) ma ingresso NON verificato: qui si pubblica, non mi fido — lascio perdere la coda.`);
    }
  }

  if (!coda) {
    await fotografaControlli("controlli dopo i tentativi");
    return {
      trovata: false,
      scritto: false,
      passi,
      root: null,
      dettaglio: scaduto()
        ? "Tempo scaduto prima di entrare nella coda «Rispondere a recensioni»: vedi il passo-passo."
        : "Non sono riuscito a entrare nella coda «Rispondere a recensioni». Nel passo-passo ci sono i controlli visti davvero (pagina e iframe): servono per calibrare l'etichetta esatta.",
    };
  }

  /**
   * Il RIQUADRO della recensione mostrata adesso. Si parte dal campo di
   * risposta (nella coda è già aperto) e si sale di antenato in antenato: il
   * primo che contiene anche il tasto «Ignora» è il riquadro completo
   * (autore + recensione + campo + tasti). Se non lo si trova così, ci si
   * accontenta del primo antenato con abbastanza testo, dicendolo.
   */
  const cartaCorrente = async (r: Radice): Promise<{ loc: Locator; via: string } | null> => {
    const partenze: [string, Locator | null][] = [
      ["il campo di risposta", await primoVisibile(campiDiRisposta(r))],
      ["«Ignora»", await primoVisibile(tastoIgnora(r))],
    ];
    let ripiego: { loc: Locator; via: string } | null = null;
    for (const [da, base] of partenze) {
      if (!base) continue;
      let n: Locator = base;
      for (let i = 0; i < 10; i++) {
        n = n.locator("xpath=..");
        const t = ((await n.innerText().catch(() => "")) || "").trim();
        if (t.length < 40) continue;
        // Un antenato che contiene «Ignora» contiene tutta la recensione
        // mostrata: è quello il riquadro. (Qui `n` è un Locator, non una
        // radice, quindi il tasto si cerca in tutt'e due i modi a mano.)
        const conIgnora =
          (await n
            .getByRole("button", { name: etichettaIgnora })
            .count()
            .catch(() => 0)) +
          (await n
            .locator("button")
            .filter({ hasText: /^\s*(ignora|ignore|salta|skip)\s*$/i })
            .count()
            .catch(() => 0));
        if (conIgnora > 0) return { loc: n, via: `${i + 1} livelli sopra ${da}` };
        ripiego = ripiego ?? { loc: n, via: `${i + 1} livelli sopra ${da} (senza «Ignora»)` };
      }
    }
    return ripiego;
  };

  /** Autore = prima riga utile del riquadro (saltando il contatore). */
  const autoreDi = (testoCarta: string): string => {
    for (const riga of testoCarta.split("\n").map((x) => x.trim())) {
      if (!riga) continue;
      if (contatoreCoda.test(riga) && /recension/i.test(riga)) continue;
      return riga.slice(0, 60);
    }
    return "";
  };

  /**
   * Legge la recensione MOSTRATA ORA nel pop-up della coda, prendendo ogni
   * pezzo dall'elemento giusto. Calibrato sull'HTML vero del pop-up, dove
   * leggere «il testo del riquadro» non funziona per due motivi:
   *
   *  1. il nome del recensore sta in un <a> verso il suo profilo che contiene
   *     ANCHE l'icona «apri in una nuova finestra». Quell'icona è una legatura
   *     testuale, quindi il testo dell'elemento non è «D» ma «Dopen_in_new»: il
   *     confronto col nome non poteva combaciare mai. Qui l'icona si toglie;
   *  2. la recensione lunga è mostrata TAGLIATA, con «Visualizza la recensione
   *     completa»; il testo intero c'è, ma in un nodo con display:none, che
   *     innerText non restituisce. Qui si legge textContent, che lo prende.
   *
   * E si resta DENTRO il dialogo: sotto al pop-up c'è la lista della sede con
   * le altre recensioni, che altrimenti si mescolerebbero a questa.
   */
  const leggiMostrata = (
    r: Radice,
  ): Promise<{ autore: string; stelle: string; testo: string; contatore: string; via: string }> =>
    r
      .evaluate(() => {
        // Niente funzioni con nome qui dentro: sotto tsx diventerebbero
        // __name(...) e la evaluate lancerebbe. Tutto inline.
        // Il dialogo VISIBILE, se c'è: sotto al pop-up resta la lista della
        // sede, e prendere il primo elemento del documento voleva dire leggere
        // la recensione sbagliata (per giunta nascosta).
        let dlg: Element | null = null;
        for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
          const box = d.getBoundingClientRect();
          if (box.width > 2 && box.height > 2) {
            dlg = d;
            break;
          }
        }
        const ambito: Element = dlg || document.body;
        let art: Element | null = null;
        for (const a of Array.from(ambito.querySelectorAll("article"))) {
          const box = a.getBoundingClientRect();
          if (box.width > 2 && box.height > 2) {
            art = a;
            break;
          }
        }
        if (!art) art = ambito;

        // Autore: il link al profilo del recensore. Si toglie tutto ciò che è
        // decorativo (icone, svg, roba aria-hidden) prima di leggere il testo.
        let autore = "";
        const a =
          art.querySelector('a[href*="/maps/contrib/"]') ||
          art.querySelector('a[jsname="xs1xe"]') ||
          art.querySelector('a[aria-label*="recensore" i]');
        if (a) {
          const copia = a.cloneNode(true) as HTMLElement;
          copia
            .querySelectorAll('i, svg, [aria-hidden="true"], .google-symbols, .notranslate')
            .forEach((e) => e.remove());
          autore = (copia.textContent || "").replace(/\s+/g, " ").trim();
        }

        // Stelle: stanno nell'etichetta per i lettori di schermo.
        let stelle = "";
        const st =
          art.querySelector('[role="img"][aria-label*="stelle" i]') ||
          art.querySelector('[role="img"][aria-label*="star" i]');
        if (st) stelle = (st.getAttribute("aria-label") || "").trim();

        // Testo: da una COPIA senza icone (altrimenti «open_in_new» finisce
        // dentro la recensione), e con textContent, così arriva anche la parte
        // NASCOSTA — il testo per intero e l'originale sotto la traduzione,
        // che innerText non restituirebbe.
        const copiaArt = art.cloneNode(true) as HTMLElement;
        copiaArt
          .querySelectorAll("i, svg, .google-symbols, .notranslate")
          .forEach((e) => e.remove());
        const testo = (copiaArt.textContent || "").replace(/\s+/g, " ").trim();

        // Contatore «N di M recensioni», dentro il dialogo.
        let contatore = "";
        for (const e of Array.from(ambito.querySelectorAll("div, span"))) {
          const t = (e.textContent || "").replace(/\s+/g, " ").trim();
          if (t.length >= 40 || !/^\d+\s+di\s+\d+\s+recension/i.test(t)) continue;
          const box = e.getBoundingClientRect();
          if (box.width < 2 || box.height < 2) continue;
          contatore = t;
          break;
        }

        return {
          autore,
          stelle,
          testo,
          contatore,
          via: dlg ? "dialogo della coda" : "pagina (nessun dialogo)",
        };
      })
      .catch((e) => ({
        autore: "",
        stelle: "",
        testo: "",
        contatore: "",
        via: `lettura fallita: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
      }));

  let trovatoCliente = false;
  let autoreTrovato = "";
  let salti = 0;
  let riprese = 0;
  let fermi = 0;
  let senzaCarta = 0;
  for (let i = 0; i <= maxIgnora; i++) {
    if (scaduto()) {
      annota(`tempo esaurito dopo ${salti} «Ignora»: mi fermo per darti comunque il passo-passo.`);
      break;
    }

    // Chi è la recensione mostrata ADESSO. È il cuore del metodo: si confronta
    // il nome con l'AUTORE di QUESTO riquadro, non col testo di tutta la
    // pagina — altrimenti si scrive sulla prima che capita.
    // Se il riquadro non si isola NON ci si ferma: la coda mostra una
    // recensione alla volta, quindi il testo dell'intera vista è comunque
    // quello della recensione mostrata. Fermarsi qui era il difetto: si
    // usciva senza aver premuto «Ignora» nemmeno una volta.
    const vista = await leggiMostrata(coda);
    let autore = vista.autore;
    let testoCarta = vista.testo;
    if (!testoCarta) {
      // Ripiego: il vecchio modo, agganciandosi al riquadro attorno al campo.
      const carta = await cartaCorrente(coda);
      if (carta) testoCarta = ((await carta.loc.innerText().catch(() => "")) || "").trim();
      if (!autore) autore = autoreDi(testoCarta);
      senzaCarta++;
      if (senzaCarta === 1) annota(`lettura diretta a vuoto (${vista.via}): ripiego sul riquadro.`);
    }
    if (!testoCarta) {
      annota(`la vista non ha testo leggibile dopo ${salti} «Ignora»: mi fermo.`);
      await fotografaControlli("controlli senza testo");
      break;
    }
    annota(
      `recensione ${salti + 1}${vista.contatore ? " [" + vista.contatore + "]" : ""}: autore «${autore}»${vista.stelle ? " · " + vista.stelle : ""} · «${testoCarta.slice(0, 90)}…»`,
    );

    // Si va avanti con «Ignora» finché non combacia il CONTENUTO o l'autore.
    // Il contenuto vale più del nome: è l'unica prova che regge quando il
    // recensore si chiama «D» o quando due clienti sono omonimi.
    const perTesto = testoAtteso ? stessoContenuto(testoCarta, testoAtteso) : false;
    const perNome = eSuaLaRecensione(autore, nome);
    if (perTesto || perNome) {
      trovatoCliente = true;
      autoreTrovato = autore;
      const come =
        perTesto && perNome
          ? "il testo E l'autore"
          : perTesto
            ? "il TESTO della recensione"
            : "l'autore";
      annota(`trovata dopo ${salti} «Ignora»: combacia ${come}.`);
      // Il riquadro per intero (stelle comprese, se sono testo): è quello che
      // serve a chi deve controllare con i propri occhi che sia la sua.
      annota(
        `la recensione trovata${vista.stelle ? " (" + vista.stelle + ")" : ""} dice: «${testoCarta.slice(0, 300)}»`,
      );
      break;
    }
    if (combaciaNome(autore, nome)) {
      annota(`  autore «${autore}»: si somiglia a «${nome}» ma non è lo stesso nome, vado avanti.`);
    } else if (combaciaNome(testoCarta, nome)) {
      annota(`  «${nome}» compare nel testo ma l'autore è «${autore}»: non è la sua, vado avanti.`);
    }

    const contatorePrima = vista.contatore;

    let b = await primoVisibile(tastoIgnora(coda));
    if (!b) {
      for (const r of radici()) {
        const alt = await primoVisibile(tastoIgnora(r));
        if (alt) {
          coda = r;
          b = alt;
          annota(`«Ignora» ritrovato in ${nomeRadice(r)}: riaggancio la coda lì.`);
          break;
        }
      }
    }
    if (!b) {
      annota(`nessun «Ignora» visibile dopo ${salti} salti: coda finita o vista cambiata.`);
      await fotografaControlli("controlli dove si è fermata");
      break;
    }
    try {
      await b.click({ timeout: 5000 });
      salti++;
    } catch (e) {
      annota(`«Ignora» n. ${salti + 1}: click FALLITO — ${perche(e)}`);
      const nuova = riprese < 2 ? (await leggiSegnali()).radice : null;
      if (nuova) {
        riprese++;
        coda = nuova;
        annota(`  riaggancio la coda su ${nomeRadice(nuova)} e riprovo.`);
        continue;
      }
      await fotografaControlli("controlli al click fallito");
      break;
    }
    await pg.waitForTimeout(700);

    // Guardia sui salti a vuoto: se dopo «Ignora» il riquadro mostra lo STESSO
    // autore, quel tasto non era della coda (di solito è quello di un banner).
    const dopo = await leggiMostrata(coda);
    const dopoAutore = dopo.autore;
    const dopoContatore = dopo.contatore;
    if (dopoAutore && dopoAutore === autore && dopoContatore === contatorePrima) {
      fermi++;
      annota(`«Ignora» n. ${salti}: l'autore mostrato è ancora «${autore}» — quel tasto non fa avanzare la coda.`);
      if (fermi >= 2) {
        await fotografaControlli("controlli dove la vista non cambia");
        break;
      }
    } else {
      fermi = 0;
    }
  }

  if (!trovatoCliente) {
    return {
      trovata: false,
      scritto: false,
      passi,
      root: coda,
      dettaglio: `«${nome}» non trovato: ${salti} «Ignora» fatti su un massimo di ${maxIgnora}${scaduto() ? " — TEMPO SCADUTO, non è arrivato in fondo alla coda" : ""}. Nel passo-passo c'è l'autore di ogni recensione vista, e il motivo per cui si è fermato.`,
    };
  }

  if (!testo.trim()) {
    return {
      trovata: true,
      scritto: false,
      passi,
      root: coda,
      autore: autoreTrovato,
      dettaglio: `Trovato «${nome}» (autore «${autoreTrovato}»): campo pronto, non ho scritto niente (nessun testo da scrivere).`,
    };
  }

  // --- Scrittura: UNA volta sola ---------------------------------------------
  // Il campo è GIÀ APERTO per la recensione mostrata (nessun «Rispondi» da
  // cliccare prima). Prima si sceglie il campo, poi si scrive, poi si rilegge.
  // Le regole vengono da un caso vero — la risposta a «D» scritta TRE volte:
  //  1. i tasti vanno dove sta il FOCUS: prima di battere si controlla che il
  //     focus sia su un campo di testo, e il contenuto si rilegge da lì, non da
  //     un locator che nel frattempo può risolversi su un altro elemento;
  //  2. si scrive SOLO in un campo vuoto: se c'è già qualcosa lo si svuota
  //     prima, e se non si riesce non si scrive affatto (mai accodare);
  //  3. i ritorni a capo si normalizzano: dal form il testo arriva con «\r\n»
  //     e Playwright batte Invio per ENTRAMBI i caratteri — righe vuote doppie
  //     nella risposta, e il confronto con quanto scritto non tornava più;
  //  4. il confronto è a spazi normalizzati e conta QUANTE volte il testo
  //     compare: dev'essere una. Altrimenti si svuota e si riscrive UNA volta;
  //     se ancora non torna ci si arrende, senza pubblicare.
  // Prima si scriveva e si rileggeva per ogni candidato: al primo confronto
  // fallito si passava al successivo — che era lo STESSO campo — e si
  // riscriveva. Tre candidati risolvevano sullo stesso <textarea>: tre volte.
  const campi = [
    ["placeholder «Risposta pubblica»", coda.getByPlaceholder(/Risposta pubblica/i)],
    ["placeholder «La tua risposta»", coda.getByPlaceholder(/La tua risposta/i)],
    ["textbox col nome «rispost…»", coda.getByRole("textbox", { name: /rispost|risposta/i })],
    ["textarea", coda.locator("textarea")],
    ["contenteditable", coda.locator('[contenteditable="true"]')],
    ["un campo qualunque della coda", campiDiRisposta(coda)],
  ] as const;
  const testoDaScrivere = testo.replace(/\r\n?/g, "\n").trim();
  const ridotto = (s: string) => s.replace(/\s+/g, " ").trim();
  const attesoRidotto = ridotto(testoDaScrivere);
  const inizioAtteso = attesoRidotto.slice(0, 24);
  const quante = (s: string, ago: string): number => (ago ? s.split(ago).length - 1 : 0);
  const anteprima = (s: string) => ridotto(s).slice(0, 60);

  type Fuoco =
    | { ok: true; tag: string; editabile: boolean; valore: string; nome: string }
    | { ok: false; errore: string };
  /** Cosa c'è nel campo che ha il FOCUS. `ok: false` = non sono riuscito a guardare. */
  const leggiFuoco = async (): Promise<Fuoco> => {
    try {
      const f = await coda.evaluate(() => {
        // Tutto inline: niente funzioni con nome dentro evaluate (sotto tsx
        // finiscono avvolte in __name, che nel browser non esiste).
        let a: Element | null = document.activeElement;
        // Se il focus sta in un iframe dello stesso dominio, si scende.
        while (a && a.tagName.toLowerCase() === "iframe") {
          const d = (a as HTMLIFrameElement).contentDocument;
          if (!d) break;
          a = d.activeElement;
        }
        if (!a || a === document.body) return { tag: "", editabile: false, valore: "", nome: "" };
        const tag = a.tagName.toLowerCase();
        const campo = tag === "textarea" || tag === "input";
        const editabile = campo || (a as HTMLElement).isContentEditable === true;
        const valore = campo ? (a as HTMLTextAreaElement).value : a.textContent || "";
        const nome = a.getAttribute("aria-label") || a.getAttribute("placeholder") || "";
        return { tag, editabile, valore, nome };
      });
      return { ok: true, ...f };
    } catch (e) {
      return { ok: false, errore: perche(e) };
    }
  };

  let campoAttivo: Locator | null = null;
  let viaCampo = "";
  /** Legge il campo: dal focus se è un campo di testo, altrimenti dal locator scelto. */
  const leggiCampo = async (): Promise<string> => {
    const f = await leggiFuoco();
    if (f.ok && f.editabile) return f.valore;
    if (!campoAttivo) return "";
    return (
      (await campoAttivo.inputValue().catch(() => null)) ??
      (await campoAttivo.innerText().catch(() => "")) ??
      ""
    );
  };
  /** Svuota il campo a fuoco (seleziona tutto + Canc) e dice cosa ci resta. */
  const svuota = async (): Promise<string> => {
    await pg.keyboard.press("Control+A").catch(() => {});
    await pg.keyboard.press("Delete").catch(() => {});
    await pg.waitForTimeout(150);
    return leggiCampo();
  };

  // 1) Il campo: il primo candidato VISIBILE che, cliccato, prende il focus.
  for (const [via, loc] of campi) {
    if (
      await loc
        .count()
        .then((n) => n === 0)
        .catch(() => true)
    )
      continue;
    const c = await primoVisibile(loc);
    if (!c) {
      annota(`campo (${via}): presente ma non visibile, salto.`);
      continue;
    }
    try {
      await c.click({ timeout: 4000 });
    } catch (e) {
      annota(`campo (${via}): click FALLITO — ${perche(e)}`);
      continue;
    }
    await pg.waitForTimeout(150);
    const f = await leggiFuoco();
    if (!f.ok) {
      annota(`campo (${via}): non riesco a leggere dove sta il focus (${f.errore}); mi fido del click.`);
      campoAttivo = c;
      viaCampo = via;
      break;
    }
    if (!f.editabile) {
      annota(
        `campo (${via}): cliccato, ma il focus non è su un campo di testo (${f.tag ? `<${f.tag}>` : "niente a fuoco"}): non ci scrivo. Provo il prossimo.`,
      );
      continue;
    }
    annota(`campo (${via}): a fuoco <${f.tag}>${f.nome ? ` «${f.nome}»` : ""}.`);
    campoAttivo = c;
    viaCampo = via;
    break;
  }
  if (!campoAttivo) {
    await fotografaControlli("controlli senza campo di risposta");
    return {
      trovata: true,
      scritto: false,
      passi,
      root: coda,
      autore: autoreTrovato,
      dettaglio: `Trovato «${nome}» (autore «${autoreTrovato}») ma non ho trovato il campo «Risposta pubblica» dove scrivere.`,
    };
  }

  // 2-4) Si scrive una volta e si rilegge; al massimo un secondo tentativo, e
  //      solo dopo aver visto il campo vuoto.
  let scrittoBene = false;
  let letto = "";
  for (let tentativo = 1; tentativo <= 2 && !scrittoBene; tentativo++) {
    let dentro = (await leggiCampo()).trim();
    if (dentro) {
      annota(`nel campo c'è già del testo («${anteprima(dentro)}»): lo svuoto prima di scrivere.`);
      await campoAttivo.click({ timeout: 3000 }).catch(() => {});
      dentro = (await svuota()).trim();
      if (dentro) {
        annota(`non riesco a svuotarlo (resta «${anteprima(dentro)}»): NON scrivo, per non accodare.`);
        break;
      }
    }
    try {
      await pg.keyboard.type(testoDaScrivere, { delay: 15 });
    } catch (e) {
      annota(`scrittura interrotta — ${perche(e)}`);
    }
    await pg.waitForTimeout(350);
    letto = ridotto(await leggiCampo());
    const volte = quante(letto, inizioAtteso);
    if (volte === 1 && letto === attesoRidotto) {
      scrittoBene = true;
      break;
    }
    const poi = tentativo < 2 ? "svuoto e riscrivo una volta" : "mi arrendo";
    if (volte > 1) {
      annota(`tentativo ${tentativo}: il testo compare ${volte} volte nel campo — ${poi}.`);
    } else if (volte === 0) {
      annota(`tentativo ${tentativo}: il testo NON è nel campo (letto «${anteprima(letto)}») — ${poi}.`);
    } else {
      let i = 0;
      while (i < letto.length && i < attesoRidotto.length && letto[i] === attesoRidotto[i]) i++;
      annota(
        `tentativo ${tentativo}: il testo c'è ma non è identico (dal carattere ${i + 1}: letto «${letto.slice(i, i + 30)}», atteso «${attesoRidotto.slice(i, i + 30)}») — ${poi}.`,
      );
    }
  }
  if (!scrittoBene) {
    // Non si lascia in giro un testo sbagliato: si prova a togliere quello che c'è.
    await campoAttivo.click({ timeout: 3000 }).catch(() => {});
    await svuota();
    await fotografaControlli("controlli dopo la scrittura fallita");
    return {
      trovata: true,
      scritto: false,
      passi,
      root: coda,
      autore: autoreTrovato,
      dettaglio: `Trovato «${nome}» (autore «${autoreTrovato}») ma nel campo non è rimasta la risposta giusta (letto «${anteprima(letto)}»): NON pubblico. Nel passo-passo c'è cosa ha letto.`,
    };
  }
  annota(`scritto nel campo (${viaCampo}) una volta sola: ${testoDaScrivere.length} caratteri, riletti e identici.`);

  // Il pulsante d'invio si guarda solo per sapere se si è acceso (prova che il
  // testo è stato accettato). Questa funzione non lo clicca MAI da sé: in
  // uscita «lascia» la decisione è di chi ha chiamato.
  const submit = coda.getByRole("button", { name: /^rispondi$/i }).first();
  const abilitato =
    (await submit.count().catch(() => 0)) > 0 ? await submit.isEnabled().catch(() => false) : false;
  annota(`bottone «Rispondi» (invio) abilitato: ${abilitato}.`);

  if (uscita === "sicura") {
    // Si esce senza pubblicare: si svuota lo STESSO campo appena scritto, poi
    // «Ignora» (salta alla successiva senza inviare) — qui non c'è un «Annulla».
    await campoAttivo.click({ timeout: 3000 }).catch(() => {});
    await svuota();
    // Dev'essere l'«Ignora» VISIBILE della coda. Prendere il primo del DOM
    // significava prendere quello NASCOSTO di un banner rimasto nella lista:
    // il click restava appeso su un elemento invisibile e falliva in silenzio,
    // lasciando la recensione lì invece di passare oltre.
    const ignoraFinale = await primoVisibile(tastoIgnora(coda));
    if (ignoraFinale) {
      await ignoraFinale.click({ timeout: 4000 }).catch(() => {});
      annota("campo svuotato e «Ignora» cliccato: uscito senza pubblicare.");
    } else {
      annota("campo svuotato; nessun «Ignora» per uscire, lascio la vista com'è (niente pubblicato).");
    }
    return {
      trovata: true,
      scritto: true,
      passi,
      root: null,
      autore: autoreTrovato,
      dettaglio: `Trovato «${nome}» (autore «${autoreTrovato}») in ${salti} salti, scritto nel campo (invio abilitato: ${abilitato}) — NON pubblicato.`,
    };
  }

  if (uscita === "ferma") {
    annota(
      "mi fermo qui: recensione a schermo e risposta già scritta nel riquadro. Non pubblico e non scarto — controlla tu e decidi.",
    );
    return {
      trovata: true,
      scritto: true,
      passi,
      root: coda,
      autore: autoreTrovato,
      dettaglio: `Trovato «${nome}» (autore «${autoreTrovato}») dopo ${salti} «Ignora». Risposta SCRITTA nel riquadro e finestra lasciata aperta sul server: controlla che sia la recensione giusta. Non ho pubblicato né scartato (invio abilitato: ${abilitato}).`,
    };
  }

  annota("testo lasciato nel riquadro: la pubblicazione la decide chi ha chiesto il lavoro.");
  return {
    trovata: true,
    scritto: true,
    passi,
    root: coda,
    autore: autoreTrovato,
    dettaglio: `Trovato «${nome}» (autore «${autoreTrovato}») in ${salti} salti con la coda, testo pronto nel riquadro (invio abilitato: ${abilitato}).`,
  };
}

/**
 * Il tasto di PROVA (solo admin): stesso metodo, ma si FERMA sulla recensione
 * trovata con la risposta già scritta nel riquadro, senza pubblicare e senza
 * scartare — così una persona può guardare lo schermo del server e verificare
 * che sia davvero quella giusta prima di decidere. La finestra la chiude lei.
 */
export function provaCodaIgnora(
  root: Radice,
  nomeCliente: string,
  testo: string,
  opts: {
    maxIgnora?: number;
    log?: (m: string) => void;
    scadenza?: number;
    testoRecensione?: string;
  } = {},
): Promise<EsitoCodaIgnora> {
  return cercaNellaCoda(root, nomeCliente, testo, { ...opts, uscita: "ferma" });
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
  /**
   * `conCoda` (di default ACCESO) prova prima la coda «Rispondere a
   * recensioni»; `scadenza` è il momento oltre il quale la coda smette di
   * saltare e lascia il posto al ripiego sulla lista.
   */
  opts: {
    log?: (m: string) => void;
    conCoda?: boolean;
    scadenza?: number;
    /** Il testo della recensione dal database: serve alla coda per riconoscerla. */
    testoRecensione?: string;
  } = {},
): Promise<EsitoPerSede> {
  const log = opts.log ?? (() => {});
  const conCoda = opts.conCoda ?? true;

  const sede = await apriSedePerNome(page, nomeGoogle, { log });
  if (!sede.root) {
    return { trovata: false, scritto: false, root: null, dettaglio: `sede «${nomeGoogle}»: ${sede.dettaglio}` };
  }
  if (!sede.aperta) {
    // La lista non mostra «Rispondi», ma la coda non ne ha bisogno: si prova
    // lo stesso invece di arrendersi qui.
    log(`la lista non mostra «Rispondi» (${sede.dettaglio}): provo lo stesso.`);
  }
  let root = sede.root;

  // 1) Prima la CODA «Rispondere a recensioni»: mostra SOLO le recensioni
  //    ancora senza risposta, una alla volta, e si salta con «Ignora» finché
  //    non compare l'autore giusto. In una sede con centinaia di recensioni è
  //    molto più diretto che scorrere la lista.
  if (conCoda) {
    const c = await cercaNellaCoda(root, nomeCliente, testo, {
      log,
      uscita: "lascia",
      scadenza: opts.scadenza,
      testoRecensione: opts.testoRecensione,
    });
    if (c.trovata && c.scritto && c.root) {
      return {
        trovata: true,
        scritto: true,
        root: c.root,
        dettaglio: `sede «${nomeGoogle}» · coda: ${c.dettaglio}`,
      };
    }
    if (c.trovata) {
      // La coda l'ha RICONOSCIUTA (dal testo, non da un nome di una lettera)
      // ma non è riuscita a scrivere: l'esito è «trovata ma non scritta» e ci
      // si ferma qui. Ripiegare sulla lista per la stessa recensione vorrebbe
      // dire ricominciare con un metodo più debole — e lì il nome si cerca
      // per sottostringa, e si pubblica davvero. Era il «torna indietro e
      // ricerca da capo» che si vedeva dopo la scrittura fallita.
      log(`la coda ha trovato «${nomeCliente}» ma non ha scritto (${c.dettaglio}): mi fermo, niente ripiego sulla lista.`);
      return {
        trovata: true,
        scritto: false,
        root: c.root ?? null,
        dettaglio: `sede «${nomeGoogle}» · coda: ${c.dettaglio}`,
      };
    }
    log(`la coda non ha concluso (${c.dettaglio}): riapro la sede e ripiego sulla lista.`);
    // Dopo i salti siamo dentro la coda: per cercare nella LISTA bisogna
    // tornare al punto di partenza, altrimenti si cercherebbe nella vista
    // sbagliata.
    const sede2 = await apriSedePerNome(page, nomeGoogle, { log });
    // Qui serve la LISTA per davvero: se non è tornata (magari siamo rimasti
    // dentro la coda perché il ritorno è fallito), non si cerca alla cieca —
    // si torna indietro e tocca al ripiego sui gruppi, che è collaudato.
    if (!sede2.aperta || !sede2.root) {
      return { trovata: false, scritto: false, root: null, dettaglio: `sede «${nomeGoogle}»: ${sede2.dettaglio}` };
    }
    root = sede2.root;
  }

  // 2) Ripiego: la lista della sede, come si è sempre fatto.
  const t = await cercaClienteNelleRecensioni(root, nomeCliente, {
    log,
    testoRecensione: opts.testoRecensione,
  });
  if (!t.trovata) {
    return { trovata: false, scritto: false, root, dettaglio: `sede «${nomeGoogle}»: ${t.dettaglio}` };
  }

  const r = await rispondiAllaRecensione(root, nomeCliente, testo, {
    log,
    testoRecensione: opts.testoRecensione,
  });
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
