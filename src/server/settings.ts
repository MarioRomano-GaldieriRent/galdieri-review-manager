import { leggiCorrenti, leggiSegreti, scriviImpostazioni } from "@/server/db/impostazioni";

// Impostazioni persistite nel database MongoDB (galdieri_recensioni).
// Precedenza invariata: valore salvato qui > variabile d'ambiente del .env.
//
// I valori segreti (client secret, API key, refresh token) NON stanno nel
// database ma nel .env, e in data/segreti.json se digitati dal pannello: il
// database è il file che si copia e si apre per guardare le statistiche, e una
// credenziale non deve poter comparire in una query fatta per curiosità.
// La differenza è invisibile da qui: pick() continua a funzionare identico.

export type Label = {
  id: string;
  name: string;
  /** Parte dell'oggetto che identifica le email dell'etichetta. */
  subjectContains: string;
  /** Filtro opzionale sul mittente (sottostringa dell'indirizzo). */
  fromContains: string;
};

export type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  graphUrl: string;
};

export type TranslatorConfig = {
  key: string;
  region: string;
  endpoint: string;
};

export type FreshdeskConfig = {
  /** Es. galdierirent.freshdesk.com */
  domain: string;
  apiKey: string;
};

export type GoogleReviewsConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Es. accounts/1234567890 */
  accountId: string;
};

/**
 * Modalità operativa dell'applicazione.
 *
 *  simulazione — nessuna scrittura verso l'esterno. Le automazioni leggono i
 *                dati veri (per dire quale ticket avrebbero toccato) ma non
 *                modificano nulla su Freshdesk, Google o la posta.
 *  reale       — le automazioni eseguono davvero. Va attivata a mano e resta
 *                comunque a conferma: si parte una recensione alla volta.
 */
export type ModoOperativo = "simulazione" | "reale";

export type AutomationConfig = {
  /** Casella a cui inoltrare le recensioni negative. */
  emailEscalation: string;
  /** Testo di accompagnamento dell'inoltro. */
  testoEscalation: string;
  /** Id agente Freshdesk che lavora le recensioni positive. */
  agenteMarketing: string;
  /** Id agente Freshdesk che riceve le negative. */
  agenteEscalation: string;
  /** Tipo ticket usato per le recensioni Google. */
  tipoTicketGoogle: string;
};

export type Settings = {
  /** Casella da leggere; vuoto = usa MAIL_WATCH_ADDRESS dal .env */
  mailbox: string;
  /** Simulazione o reale. Default: simulazione. */
  modo: ModoOperativo;
  labels: Label[];
  graph: Partial<GraphConfig>;
  translator: Partial<TranslatorConfig>;
  freshdesk: Partial<FreshdeskConfig>;
  googleReviews: Partial<GoogleReviewsConfig>;
  automation: Partial<AutomationConfig>;
};

export const DEFAULT_AUTOMATION: AutomationConfig = {
  emailEscalation: "cherubina.panico@galdierirent.it",
  testoEscalation: "Si trasmette per quanto di competenza.",
  agenteMarketing: "80108775423",
  agenteEscalation: "80128977810",
  tipoTicketGoogle: "Recensioni clienti GMB",
};

export const DEFAULT_SETTINGS: Settings = {
  mailbox: "",
  modo: "simulazione",
  labels: [
    {
      id: "recensioni-google",
      name: "Recensioni di Google",
      subjectContains: "NUOVA RECENSIONE GOOGLE",
      // Le recensioni arrivano da Zapier "per conto di" customer.care:
      // vuoto = prendi tutti i mittenti del flusso.
      fromContains: "",
    },
  ],
  graph: {},
  translator: {},
  freshdesk: {},
  googleReviews: {},
  automation: {},
};

/** Ricompone una sezione dalle chiavi puntate: "graph.tenantId" -> graph.tenantId */
function sezione(valori: Record<string, string>, nome: string): Record<string, string> {
  const out: Record<string, string> = {};
  const prefisso = `${nome}.`;
  for (const [chiave, valore] of Object.entries(valori)) {
    if (chiave.startsWith(prefisso)) out[chiave.slice(prefisso.length)] = valore;
  }
  return out;
}

// Le impostazioni si leggono UNA volta ogni pochi secondi, non a ogni chiamata.
//
// Prima ogni loadSettings faceva due letture su Atlas (~25 ms l'una), e la home
// la chiamava 20-60 volte per render senza accorgersene: page.tsx, i controlli
// isGraphConfigured/isFreshdeskConfigured, ctx() di Graph a ogni chiamata, e
// fdFetch a OGNI GET Freshdesk. Con questa memoria di processo la prima costa
// come prima, le altre nulla. TTL corto e invalidazione esplicita al salvataggio
// (saveSettings): il pannello Impostazioni vede subito le proprie modifiche, e
// un ritocco a mano a data/segreti.json arriva entro dieci secondi. In
// produzione gira un solo processo, quindi non c'è un'altra istanza da avvisare.
//
// Si conserva lo snapshot e si restituisce sempre una COPIA: le action del
// pannello mutano l'oggetto che ricevono prima di risalvarlo (vedi sotto), e
// una mutazione sullo snapshot condiviso sarebbe una modifica non salvata che
// tutti vedrebbero.
const TTL_IMPOSTAZIONI_MS = 10_000;
let memoImpostazioni: { at: number; valore: Settings } | null = null;
// Numero di generazione: cresce a ogni invalidazione. Una lettura partita PRIMA
// di un salvataggio e finita DOPO porta i valori vecchi: va restituita a chi
// l'ha chiesta, ma non deve diventare lo snapshot condiviso, altrimenti per
// dieci secondi tutti vedrebbero la modalità (o la casella) precedente.
let generazione = 0;
// Una sola lettura in volo per volta: allo scadere della memoria la home ne
// lancerebbe decine insieme (una per ogni GET Freshdesk e Graph), tutte uguali.
let letturaInCorso: Promise<Settings | null> | null = null;

/** Da chiamare dopo ogni scrittura: la prossima lettura ripassa dal database. */
export function invalidaImpostazioni(): void {
  memoImpostazioni = null;
  letturaInCorso = null;
  generazione++;
}

export async function loadSettings(): Promise<Settings> {
  const memo = memoImpostazioni;
  if (memo && Date.now() - memo.at < TTL_IMPOSTAZIONI_MS) return structuredClone(memo.valore);

  const gen = generazione;
  let lettura = letturaInCorso;
  if (!lettura) {
    const p = leggiImpostazioniDalDb(); // non rigetta mai: null se il database non risponde
    letturaInCorso = p;
    const fine = () => {
      if (letturaInCorso === p) letturaInCorso = null;
    };
    void p.then(fine, fine);
    lettura = p;
  }
  const valore = await lettura;
  // Non si memorizza: il ripiego ai default (database irraggiungibile: la
  // richiesta successiva deve riprovare, non insistere sui default) e una
  // lettura scavalcata da un'invalidazione nel frattempo.
  if (valore && gen === generazione) memoImpostazioni = { at: Date.now(), valore };
  return structuredClone(valore ?? DEFAULT_SETTINGS);
}

/** Lettura vera: null se il database non risponde (il chiamante ripiega ai default). */
async function leggiImpostazioniDalDb(): Promise<Settings | null> {
  try {
    // I segreti arrivano dal file dedicato e si sovrappongono ai valori del
    // database, dove per costruzione non possono esistere. Valori ed etichette
    // vengono dallo stesso documento: una lettura sola.
    const correnti = await leggiCorrenti();
    const valori = { ...correnti.valori, ...leggiSegreti() };
    const labels = correnti.etichette;

    return {
      mailbox: valori.mailbox ?? "",
      // Qualsiasi valore diverso da "reale" ricade su simulazione. Il CHECK
      // sulla colonna lo rinforza, ma la lettura resta prudente comunque:
      // sbagliare qui abilita scritture vere su Freshdesk, Google e posta.
      modo: valori.modo === "reale" ? "reale" : "simulazione",
      // Nessuna etichetta = quella di default, come prima: cancellare l'ultima
      // dal pannello la fa riapparire al ricaricamento.
      //
      // COPIA, mai il riferimento: le action del pannello mutano l'oggetto che
      // ricevono prima di risalvarlo, e passando la costante si finirebbe per
      // modificare il default per tutta la vita del processo.
      labels: labels.length > 0 ? labels : DEFAULT_SETTINGS.labels.map((l) => ({ ...l })),
      graph: sezione(valori, "graph"),
      translator: sezione(valori, "translator"),
      freshdesk: sezione(valori, "freshdesk"),
      googleReviews: sezione(valori, "googleReviews"),
      automation: sezione(valori, "automation"),
    };
  } catch (e) {
    // Database irraggiungibile: si lavora sui default e sul .env invece di
    // lasciare tutta l'applicazione senza impostazioni. loadSettings ne fa
    // comunque una copia (structuredClone): un'action che mutasse l'oggetto
    // ricevuto — per esempio scrivendo modo = "reale" — non lo lascerebbe
    // incollato ai default per tutti.
    console.error("[impostazioni] lettura non riuscita:", e);
    return null;
  }
}

/**
 * Scrive lo snapshot completo.
 *
 * Le action del pannello fanno tutte "carica tutto → muta un pezzo → risalva
 * tutto", ed è quel meccanismo a far funzionare keep(), cioè "campo lasciato
 * vuoto = tieni quello che c'era". Un aggiornamento per singolo campo
 * cancellerebbe i segreti non ripresentati dal form.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const valori: Record<string, string> = {
    mailbox: settings.mailbox ?? "",
    modo: settings.modo === "reale" ? "reale" : "simulazione",
  };
  for (const nome of ["graph", "translator", "freshdesk", "googleReviews", "automation"] as const) {
    for (const [chiave, valore] of Object.entries(settings[nome] ?? {})) {
      if (typeof valore === "string") valori[`${nome}.${chiave}`] = valore;
    }
  }
  try {
    await scriviImpostazioni(valori, settings.labels ?? []);
  } finally {
    // Anche se la scrittura è fallita a metà (storico sì, correnti no): meglio
    // rileggere dal database che servire uno snapshot che potrebbe non
    // corrispondere più.
    invalidaImpostazioni();
  }
}

/** Casella effettivamente in uso: override dalle impostazioni, altrimenti .env */
export async function activeMailbox(): Promise<string> {
  const s = await loadSettings();
  return s.mailbox || process.env.MAIL_WATCH_ADDRESS || "";
}

/** Modalità in vigore adesso. */
export async function modoOperativo(): Promise<ModoOperativo> {
  return (await loadSettings()).modo;
}

/**
 * Unico punto in cui si decide se una scrittura verso l'esterno può partire.
 * Ogni connettore che modifica qualcosa deve chiamare questa funzione prima di
 * agire: se la modalità non è "reale" solleva un errore e l'azione non parte.
 */
export async function scritturaConsentita(): Promise<boolean> {
  return (await modoOperativo()) === "reale";
}

export async function resolveAutomation(s?: Settings): Promise<AutomationConfig> {
  const st = s ?? (await loadSettings());
  const a = st.automation;
  return {
    emailEscalation: pick(a.emailEscalation, undefined, DEFAULT_AUTOMATION.emailEscalation),
    testoEscalation: pick(a.testoEscalation, undefined, DEFAULT_AUTOMATION.testoEscalation),
    agenteMarketing: pick(a.agenteMarketing, undefined, DEFAULT_AUTOMATION.agenteMarketing),
    agenteEscalation: pick(a.agenteEscalation, undefined, DEFAULT_AUTOMATION.agenteEscalation),
    tipoTicketGoogle: pick(a.tipoTicketGoogle, undefined, DEFAULT_AUTOMATION.tipoTicketGoogle),
  };
}

const pick = (saved: string | undefined, env: string | undefined, fallback = "") =>
  (saved && saved.trim()) || env || fallback;

export async function resolveGraph(s?: Settings): Promise<GraphConfig> {
  const st = s ?? (await loadSettings());
  return {
    tenantId: pick(st.graph.tenantId, process.env.MICROSOFT_TENANT_ID),
    clientId: pick(st.graph.clientId, process.env.MICROSOFT_CLIENT_ID),
    clientSecret: pick(st.graph.clientSecret, process.env.MICROSOFT_CLIENT_SECRET),
    graphUrl: pick(
      st.graph.graphUrl,
      process.env.GRAPH_API_URL,
      "https://graph.microsoft.com/v1.0",
    ),
  };
}

export async function resolveTranslator(s?: Settings): Promise<TranslatorConfig> {
  const st = s ?? (await loadSettings());
  return {
    key: pick(st.translator.key, process.env.AZURE_TRANSLATOR_KEY),
    region: pick(st.translator.region, process.env.AZURE_TRANSLATOR_REGION),
    endpoint: pick(
      st.translator.endpoint,
      process.env.AZURE_TRANSLATOR_ENDPOINT,
      "https://api.cognitive.microsofttranslator.com",
    ),
  };
}

export async function resolveFreshdesk(s?: Settings): Promise<FreshdeskConfig> {
  const st = s ?? (await loadSettings());
  return {
    domain: pick(st.freshdesk.domain, process.env.FRESHDESK_DOMAIN),
    apiKey: pick(st.freshdesk.apiKey, process.env.FRESHDESK_API_KEY),
  };
}

export async function resolveGoogleReviews(s?: Settings): Promise<GoogleReviewsConfig> {
  const st = s ?? (await loadSettings());
  return {
    clientId: pick(st.googleReviews.clientId, process.env.GOOGLE_CLIENT_ID),
    clientSecret: pick(st.googleReviews.clientSecret, process.env.GOOGLE_CLIENT_SECRET),
    refreshToken: pick(st.googleReviews.refreshToken, process.env.GOOGLE_REFRESH_TOKEN),
    accountId: pick(st.googleReviews.accountId, process.env.GOOGLE_ACCOUNT_ID),
  };
}

/** Indica se un segreto è impostato, senza mai rivelarne il valore. */
export function isSet(v: string | undefined): boolean {
  return Boolean(v && v.trim());
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `etichetta-${Date.now()}`
  );
}
