import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

// Impostazioni persistite su file (niente database): data/settings.json
// Precedenza: valore salvato qui > variabile d'ambiente del .env
const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "settings.json");

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

export type Settings = {
  /** Casella da leggere; vuoto = usa MAIL_WATCH_ADDRESS dal .env */
  mailbox: string;
  labels: Label[];
  graph: Partial<GraphConfig>;
  translator: Partial<TranslatorConfig>;
  freshdesk: Partial<FreshdeskConfig>;
  googleReviews: Partial<GoogleReviewsConfig>;
};

export const DEFAULT_SETTINGS: Settings = {
  mailbox: "",
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
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(FILE, "utf8");
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      mailbox: typeof p.mailbox === "string" ? p.mailbox : "",
      labels:
        Array.isArray(p.labels) && p.labels.length > 0 ? p.labels : DEFAULT_SETTINGS.labels,
      graph: p.graph ?? {},
      translator: p.translator ?? {},
      freshdesk: p.freshdesk ?? {},
      googleReviews: p.googleReviews ?? {},
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(settings, null, 2), "utf8");
}

/** Casella effettivamente in uso: override dalle impostazioni, altrimenti .env */
export async function activeMailbox(): Promise<string> {
  const s = await loadSettings();
  return s.mailbox || process.env.MAIL_WATCH_ADDRESS || "";
}

const pick = (saved: string | undefined, env: string | undefined, fallback = "") =>
  (saved && saved.trim()) || env || fallback;

export async function resolveGraph(s?: Settings): Promise<GraphConfig> {
  const st = s ?? (await loadSettings());
  return {
    tenantId: pick(st.graph.tenantId, process.env.MICROSOFT_TENANT_ID),
    clientId: pick(st.graph.clientId, process.env.MICROSOFT_CLIENT_ID),
    clientSecret: pick(st.graph.clientSecret, process.env.MICROSOFT_CLIENT_SECRET),
    graphUrl: pick(st.graph.graphUrl, process.env.GRAPH_API_URL, "https://graph.microsoft.com/v1.0"),
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
