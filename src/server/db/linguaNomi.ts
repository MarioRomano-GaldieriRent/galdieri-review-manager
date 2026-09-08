import { coll } from "./connessione";

// Cache del riconoscimento "il nome è italiano o straniero?", decisa dall'IA
// (vedi reviews/linguaNomeAI.ts). La chiave è il nome normalizzato: lo stesso
// cliente, o due omonimi, non pagano due volte la stessa domanda a Claude.
//
// Nessuna funzione qui solleva: è un'ottimizzazione, un database occupato non
// deve bloccare la scelta fra "Grazie." e "Thank you." — chi chiama ripiega
// sull'euristica quando la cache non risponde.

export type LinguaDecisa = "it" | "altra";

/** Minuscolo, senza accenti, spazi singoli: per usare il nome come chiave. */
export function chiaveNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function leggiLinguaNome(nome: string): Promise<LinguaDecisa | null> {
  const chiave = chiaveNome(nome);
  if (!chiave) return null;
  try {
    const doc = await (await coll<{ _id: string; lingua: LinguaDecisa }>("lingua_nomi")).findOne({
      _id: chiave,
    });
    return doc?.lingua ?? null;
  } catch (e) {
    console.error("[lingua_nomi] lettura non riuscita:", e);
    return null;
  }
}

export async function salvaLinguaNome(
  nome: string,
  lingua: LinguaDecisa,
  via: "ai" | "euristica",
): Promise<void> {
  const chiave = chiaveNome(nome);
  if (!chiave) return;
  try {
    await (await coll("lingua_nomi")).updateOne(
      { _id: chiave },
      {
        $set: { lingua, via, decisaIl: new Date() },
        $setOnInsert: { nomeEsempio: nome.trim() },
      },
      { upsert: true },
    );
  } catch (e) {
    console.error("[lingua_nomi] scrittura non riuscita:", e);
  }
}
