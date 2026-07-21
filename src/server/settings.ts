import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

// Impostazioni persistite su file (niente database): data/settings.json
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

export type Settings = {
  /** Casella da leggere; vuoto = usa MAIL_WATCH_ADDRESS dal .env */
  mailbox: string;
  labels: Label[];
};

export const DEFAULT_SETTINGS: Settings = {
  mailbox: "",
  labels: [
    {
      id: "recensioni-google",
      name: "Recensioni di Google",
      subjectContains: "NUOVA RECENSIONE GOOGLE",
      // Le recensioni arrivano da Zapier "per conto di" customer.care:
      // vuoto = prendi tutti i mittenti del flusso (Zapier, Freshdesk, risposte interne).
      fromContains: "",
    },
  ],
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      mailbox: typeof parsed.mailbox === "string" ? parsed.mailbox : "",
      labels: Array.isArray(parsed.labels) && parsed.labels.length > 0
        ? parsed.labels
        : DEFAULT_SETTINGS.labels,
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
