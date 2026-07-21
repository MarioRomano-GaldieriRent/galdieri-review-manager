import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { resolveTranslator } from "@/server/settings";

// Traduzione in italiano tramite Azure AI Translator.
// I risultati sono messi in cache su file: ogni testo si traduce una volta sola.

const CACHE_FILE = path.join(process.cwd(), "data", "translations.json");

export async function isTranslationConfigured(): Promise<boolean> {
  const cfg = await resolveTranslator();
  return Boolean(cfg.key && cfg.region);
}

export type Translated = {
  /** Testo in italiano (uguale all'originale se era già in italiano). */
  italian: string;
  /** Lingua rilevata, es. "de", "fr", "it". */
  detected: string;
  /** true se il testo era già in italiano e non è stato tradotto. */
  alreadyItalian: boolean;
};

type CacheEntry = { italian: string; detected: string };
let cache: Record<string, CacheEntry> | null = null;

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 20);
}

async function loadCache(): Promise<Record<string, CacheEntry>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Record<string, CacheEntry>;
  } catch {
    cache = {};
  }
  return cache;
}

async function persistCache(): Promise<void> {
  if (!cache) return;
  try {
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // La cache è un'ottimizzazione: se non si riesce a scrivere si prosegue.
  }
}

/**
 * Traduce in italiano una lista di testi. Ritorna null per ogni elemento se il
 * servizio non è configurato o la chiamata fallisce (l'app mostra l'originale).
 */
export async function translateToItalian(texts: string[]): Promise<(Translated | null)[]> {
  const result: (Translated | null)[] = texts.map(() => null);
  const cfg = await resolveTranslator();
  if (!cfg.key || !cfg.region) return result;

  const store = await loadCache();
  const daTradurre: { index: number; text: string; key: string }[] = [];

  texts.forEach((text, i) => {
    const clean = text.trim();
    if (!clean) return;
    const k = hash(clean);
    const hit = store[k];
    if (hit) {
      result[i] = {
        italian: hit.italian,
        detected: hit.detected,
        alreadyItalian: hit.detected === "it",
      };
    } else {
      daTradurre.push({ index: i, text: clean, key: k });
    }
  });

  if (daTradurre.length === 0) return result;

  try {
    // Azure Translator accetta fino a 100 elementi per chiamata.
    for (let i = 0; i < daTradurre.length; i += 100) {
      const lotto = daTradurre.slice(i, i + 100);
      const res = await fetch(`${cfg.endpoint}/translate?api-version=3.0&to=it`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": cfg.key,
          "Ocp-Apim-Subscription-Region": cfg.region,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(lotto.map((x) => ({ Text: x.text }))),
        cache: "no-store",
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[translate] Azure ${res.status}: ${err.slice(0, 200)}`);
        return result;
      }

      const data = (await res.json()) as {
        detectedLanguage?: { language?: string };
        translations?: { text?: string }[];
      }[];

      data.forEach((row, j) => {
        const item = lotto[j];
        if (!item) return;
        const detected = row.detectedLanguage?.language ?? "";
        const italian = row.translations?.[0]?.text ?? item.text;
        store[item.key] = { italian, detected };
        result[item.index] = { italian, detected, alreadyItalian: detected === "it" };
      });
    }

    await persistCache();
  } catch (e) {
    console.error("[translate] errore:", e instanceof Error ? e.message : e);
  }

  return result;
}

/** Prova la connessione al servizio di traduzione. */
export async function testTranslator(): Promise<{ ok: boolean; message: string }> {
  const cfg = await resolveTranslator();
  if (!cfg.key || !cfg.region) {
    return { ok: false, message: "Chiave o regione non impostate." };
  }
  try {
    const res = await fetch(`${cfg.endpoint}/translate?api-version=3.0&to=it`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": cfg.key,
        "Ocp-Apim-Subscription-Region": cfg.region,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ Text: "Excellent service, very fast." }]),
      cache: "no-store",
    });
    if (!res.ok) {
      return { ok: false, message: `Azure ${res.status}: ${(await res.text()).slice(0, 150)}` };
    }
    const data = (await res.json()) as { translations?: { text?: string }[] }[];
    return { ok: true, message: `Prova riuscita: "${data[0]?.translations?.[0]?.text ?? ""}"` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Errore sconosciuto" };
  }
}
