import { createHash } from "crypto";
import "@/server/db/avvio";
import { cercaTraduzioni, salvaTraduzioni, segnaUso } from "@/server/db/traduzioni";
import { resolveTranslator } from "@/server/settings";

// Traduzione in italiano tramite Azure AI Translator.
// I risultati sono messi in cache nel database: ogni testo si traduce una volta
// sola, e la cache non si perde più fra un processo e l'altro.

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

/**
 * Chiave di cache: sha1 del testo, tagliato a 20 caratteri.
 *
 * Identica a quella usata quando la cache stava su file. Cambiarla — anche
 * solo allungandola — vorrebbe dire non ritrovare più nulla e ripagare Azure
 * per tradurre di nuovo tutto lo storico già tradotto.
 */
function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 20);
}

/**
 * Traduce in italiano una lista di testi. Ritorna null per ogni elemento se il
 * servizio non è configurato o la chiamata fallisce (l'app mostra l'originale).
 */
export async function translateToItalian(texts: string[]): Promise<(Translated | null)[]> {
  const result: (Translated | null)[] = texts.map(() => null);
  const cfg = await resolveTranslator();
  if (!cfg.key || !cfg.region) return result;

  // Una sola interrogazione per tutto il lotto, invece di una per testo.
  const chiavi = texts.map((t) => (t.trim() ? hash(t.trim()) : ""));
  const store = cercaTraduzioni(chiavi.filter(Boolean));
  const daTradurre: { index: number; text: string; key: string }[] = [];
  const usate: string[] = [];

  texts.forEach((text, i) => {
    const clean = text.trim();
    if (!clean) return;
    const k = chiavi[i];
    const hit = store.get(k);
    if (hit) {
      result[i] = {
        italian: hit.italiano,
        detected: hit.linguaRilevata,
        alreadyItalian: hit.linguaRilevata === "it",
      };
      usate.push(k);
    } else {
      daTradurre.push({ index: i, text: clean, key: k });
    }
  });

  segnaUso(usate);

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

      const nuove = data.flatMap((row, j) => {
        const item = lotto[j];
        if (!item) return [];
        const detected = row.detectedLanguage?.language ?? "";
        const italian = row.translations?.[0]?.text ?? item.text;
        result[item.index] = { italian, detected, alreadyItalian: detected === "it" };
        return [
          {
            chiave: item.key,
            // Adesso si conserva anche il testo di partenza: sul file c'era
            // solo la traduzione, e non si poteva più sapere da cosa venisse.
            testoOriginale: item.text,
            italiano: italian,
            linguaRilevata: detected,
          },
        ];
      });

      salvaTraduzioni(nuove);
    }
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
