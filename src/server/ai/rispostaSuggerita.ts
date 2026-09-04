import type Anthropic from "@anthropic-ai/sdk";
import { claude, consumoDi, modelloClaude, type Consumo } from "./claude";
import { blocchiPerContesto, esempiPerContesto, type Esempio } from "@/server/db/memoria";
import { linguaRisposta } from "@/server/reviews/lingua";

// ---------------------------------------------------------------------------
// Generazione della risposta SUGGERITA a una recensione positiva con commento.
//
// Ambito (deciso con Mario): SOLO le positive con testo (4-5★ con commento).
// Restano fuori le negative (le gestisce il customer care) e le 5★ senza
// commento (hanno «Grazie.» di default). Il testo è sempre una PROPOSTA: viene
// precompilato nel box e pubblicato solo dopo conferma umana.
//
// Il modello riceve:
//   - i blocchi di contesto attivi del pannello Memoria (chi siamo, tono, regole)
//   - un campione delle risposte VERE già pubblicate, dello stesso tipo e lingua
// e deve restare in quello stile: frasi brevi, «Gentile signor X, … A presto.»
//
// Il prompt di sistema (contesto + esempi) è IDENTICO per tutte le recensioni
// della stessa lingua: viene messo in cache (cache_control) e dalla seconda
// chiamata in poi costa un decimo.
// ---------------------------------------------------------------------------

/** Quante risposte vere mostrare come riferimento. */
export const ESEMPI_NEL_PROMPT = 24;

export type RecensioneDaRispondere = {
  nome: string;
  stelle: number | null;
  /** Il testo del cliente (originale, non la traduzione). */
  commento: string;
  sede: string;
  /** Lingua rilevata (Azure), se disponibile. */
  lingua?: string;
};

export type Suggerimento = {
  testo: string;
  linguaRisposta: "it" | "en";
  modello: string;
  esempiUsati: number;
  consumo: Consumo;
};

const ISTRUZIONI_IT = `Scrivi la risposta pubblica di Galdieri rent a una recensione positiva su Google.

Regole:
- Rispondi in ITALIANO.
- Rivolgiti al cliente con «Gentile signor <cognome>» o «Gentile signora <cognome>», deducendo il genere dal nome. Se il nome non permette di capirlo, o non è un nome di persona, usa «Gentile <nome così com'è>».
- Resta della stessa lunghezza degli esempi: una o due frasi, di norma sotto i 200 caratteri.
- Chiudi come negli esempi (di solito «A presto.»).
- Riprendi ciò che il cliente ha apprezzato, ma con parole nostre e senza elencare tutto: basta un riferimento naturale.
- Non inventare NULLA: nessuna promessa, nessuno sconto, nessun dato, nessun fatto che il cliente non abbia scritto.
- Se il cliente cita un dipendente per nome, puoi ringraziarlo citandolo.
- Non firmare, non aggiungere saluti di apertura, non usare emoji.

Rispondi SOLTANTO con il testo della risposta, senza virgolette e senza commenti.`;

const ISTRUZIONI_EN = `Write Galdieri rent's public reply to a positive Google review.

Rules:
- Reply in ENGLISH, in correct and natural English.
- Address the customer as «Dear Mr <surname>» or «Dear Mrs <surname>», inferring gender from the name. If the name doesn't allow it, or isn't a person's name, use «Dear <name as written>».
- Keep the same length as the examples: one or two sentences, usually under 200 characters.
- Close like the examples do (usually «See you soon.»).
- Pick up what the customer appreciated, in our own words and without listing everything: one natural reference is enough.
- Invent NOTHING: no promises, no discounts, no data, no facts the customer didn't write.
- If the customer names a member of staff, you may thank them by name.
- Don't sign off, don't add an opening greeting, don't use emoji.

Note: some past examples contain English mistakes (e.g. «positive valutation», «you stay good with us»). Follow their TONE and LENGTH, never their grammar: your English must be correct.

Reply with ONLY the text of the reply, no quotation marks and no comments.`;

function bloccoEsempi(esempi: Esempio[], italiano: boolean): string {
  const righe = esempi.map((e, i) => {
    const stelle = e.stelle ? `${e.stelle}★` : "—";
    const sede = e.sedeNome ? `, ${e.sedeNome}` : "";
    const rec = e.commento.replace(/\s+/g, " ").trim();
    return (
      `${i + 1}. [${stelle}${sede}] ${italiano ? "Recensione" : "Review"}: «${rec}»\n` +
      `   ${italiano ? "Risposta pubblicata" : "Published reply"}: «${e.risposta.replace(/\s+/g, " ").trim()}»`
    );
  });
  const titolo = italiano
    ? "Risposte che abbiamo già pubblicato (è questo lo stile da tenere)"
    : "Replies we have already published (this is the style to keep)";
  return `## ${titolo}\n\n${righe.join("\n\n")}`;
}

/**
 * Genera la risposta suggerita. Non scrive nulla e non pubblica nulla: torna il
 * testo da mettere nel box, che una persona deve confermare.
 */
export async function generaRispostaSuggerita(
  r: RecensioneDaRispondere,
  opts: { escludiEsempio?: string } = {},
): Promise<Suggerimento> {
  const commento = (r.commento ?? "").trim();
  if (!commento) throw new Error("Nessun commento: per una recensione senza testo vale «Grazie.».");

  const lingua = linguaRisposta(r.lingua ?? "", commento);
  const italiano = lingua !== "altra"; // "it" e "ignota" → italiano, come nel resto dell'app
  const linguaEsempi = italiano ? "it" : "en";

  const [blocchi, esempi] = await Promise.all([
    blocchiPerContesto(),
    esempiPerContesto({
      tipo: "positiva-con-testo",
      lingua: linguaEsempi,
      limite: ESEMPI_NEL_PROMPT,
      escludi: opts.escludiEsempio ? [opts.escludiEsempio] : undefined,
    }),
  ]);

  const contesto = blocchi.map((b) => `## ${b.titolo}\n${b.testo}`).join("\n\n");
  const system = [
    contesto,
    italiano ? ISTRUZIONI_IT : ISTRUZIONI_EN,
    esempi.length > 0 ? bloccoEsempi(esempi, italiano) : "",
  ]
    .filter((p) => p.trim())
    .join("\n\n");

  const stelle = r.stelle ? `${r.stelle}` : "—";
  const utente = italiano
    ? `Recensione a cui rispondere:\nCliente: ${r.nome || "(senza nome)"}\nSede: ${r.sede || "(non indicata)"}\nPunteggio: ${stelle}/5\nCommento: «${commento}»`
    : `Review to reply to:\nCustomer: ${r.nome || "(no name)"}\nBranch: ${r.sede || "(not specified)"}\nRating: ${stelle}/5\nComment: «${commento}»`;

  const modello = modelloClaude();
  const risposta = await claude().messages.create({
    model: modello,
    max_tokens: 2000,
    // effort basso: è un compito breve e ripetitivo, non serve ragionamento profondo.
    output_config: { effort: "low" },
    // Il system (contesto + esempi) è identico per tutte le recensioni della
    // stessa lingua: in cache costa un decimo dalla seconda chiamata in poi.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: utente }],
  });

  if (risposta.stop_reason === "refusal") {
    throw new Error(
      `Il modello ha rifiutato di rispondere (${risposta.stop_details?.category ?? "motivo non indicato"}).`,
    );
  }

  const testo = risposta.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^[«"']|[»"']$/g, "") // il modello a volte incornicia il testo
    .trim();

  if (!testo) throw new Error("Il modello non ha restituito nessun testo.");

  return {
    testo,
    linguaRisposta: linguaEsempi,
    modello,
    esempiUsati: esempi.length,
    consumo: consumoDi(risposta.usage, modello),
  };
}
