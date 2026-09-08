import type Anthropic from "@anthropic-ai/sdk";
import { claude, consumoDi, modelloClaude, type Consumo } from "./claude";
import { blocchiPerContesto, esempiPerContesto, type Esempio } from "@/server/db/memoria";
import { linguaRispostaIA } from "@/server/reviews/linguaNomeAI";

// ---------------------------------------------------------------------------
// Generazione della risposta SUGGERITA a una recensione con commento.
//
// Ambito (deciso con Mario): le positive con testo (4-5★ con commento) e, dall'8
// settembre 2026, le 3★ con commento — l'ibrido in cui l'operatore sceglie fra
// la proposta e l'inoltro al customer care. Restano fuori le 1-2★ (le gestisce
// il customer care) e le recensioni senza commento (hanno «Grazie.» di
// default). Il testo è sempre una PROPOSTA: viene precompilato nel box e
// pubblicato solo dopo conferma umana.
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

// Le regole qui sotto NON sono di fantasia: sono ricavate misurando le 1.289
// risposte italiane e le 1.135 inglesi scritte davvero da Stefania
// (`npm run memoria:analisi`). Lunghezza mediana 89 caratteri in italiano e 74
// in inglese (oltre l'80% sta sotto i 120); apertura con appellativo nel 93-99%
// dei casi; chiusura «A presto.» nel 98% e «See you soon.» nel 97%. Sui nomi in
// cui il genere non è deducibile lei usa comunque il maschile nel ~60% dei casi:
// facciamo lo stesso, per non staccarci dallo storico.

const ISTRUZIONI_IT = `Scrivi la risposta pubblica di Galdieri rent a una recensione positiva su Google.

COME APRIAMO (sempre, salvo l'ultimo caso):
- «Gentile signor <cognome>,» oppure «Gentile signora <cognome>,», deducendo il genere dal nome.
- Se il cliente ha solo il nome e nessun cognome, usa lo stesso l'appellativo con il nome: «Gentile signor Michele,».
- Se il genere non si capisce dal nome, usa «signor»: è ciò che facciamo di solito.
- Solo se NON è un nome di persona (un nickname, un'azienda, una sigla) scrivi «Gentile <nome così com'è>,».

COME CHIUDIAMO:
- L'ultima frase è sempre «A presto.»

LUNGHEZZA (è la regola che sbagliamo più spesso: siamo brevi):
- Da 70 a 120 caratteri IN TUTTO, appellativo e chiusura compresi. Mai oltre 140.
- Una frase fra l'apertura e «A presto.», due solo se davvero servono.

CONTENUTO:
- Riprendi in modo naturale UNA cosa che il cliente ha apprezzato, con parole nostre. Non elencare tutto quello che ha scritto.
- Se cita un dipendente per nome, nominalo: è la cosa che fa più piacere.
- Non inventare NULLA: nessuna promessa, nessuno sconto, nessun dato, nessun fatto che il cliente non abbia scritto.
- Niente emoji, niente firma, nessun saluto d'apertura oltre all'appellativo.

Rispondi SOLTANTO con il testo della risposta, senza virgolette e senza commenti.`;

const ISTRUZIONI_EN = `Write Galdieri rent's public reply to a positive Google review.

Reply in ENGLISH, in correct and natural English.

HOW WE OPEN (always, except the last case):
- «Dear Mr <surname>,» or «Dear Mrs <surname>,», inferring gender from the name.
- If the customer has only a first name and no surname, still use the title with that name: «Dear Mr Sergio,».
- If gender can't be inferred from the name, use «Mr»: that's what we usually do.
- Only if it is NOT a person's name (a nickname, a company, a handle) write «Dear <name as written>,».

HOW WE CLOSE:
- The last sentence is always «See you soon.»

LENGTH (this is the rule we get wrong most often: be brief):
- Between 60 and 110 characters IN TOTAL, greeting and closing included. Never over 130.
- One sentence between the greeting and «See you soon.», two only if truly needed.

CONTENT:
- Naturally pick up ONE thing the customer appreciated, in our own words. Don't list everything they wrote.
- If they name a member of staff, name them back: it's what people appreciate most.
- Invent NOTHING: no promises, no discounts, no data, no facts the customer didn't write.
- No emoji, no sign-off, no opening greeting beyond the salutation.

Note: some past examples contain English mistakes (e.g. «positive valutation», «you stay good with us»). Follow their TONE and LENGTH, never their grammar: your English must be correct.

Reply with ONLY the text of the reply, no quotation marks and no comments.`;

// Le 3★ non sono positive: Stefania le ha risposte così (11 casi su 37, gli
// altri 26 li ha girati al customer care) — ringrazia per il riscontro,
// riconosce il disagio in mezza frase senza giustificarsi, riprende ciò che è
// piaciuto, chiude con «A presto.». Es. «il suo feedback è molto importante e
// sarà certamente preso in considerazione … Siamo lieti che abbia apprezzato la
// nostra professionalità.» Queste note si AGGIUNGONO alle istruzioni, sopra.
const NOTA_3_STELLE_IT = `ATTENZIONE: questa è una recensione a 3 STELLE, un giudizio intermedio — NON una positiva.
- Ringrazia per il riscontro, non per «la valutazione positiva».
- Se il cliente segnala un disagio, riconoscilo in mezza frase, senza giustificarti e senza promettere nulla.
- Se ha apprezzato qualcosa, riprendi quello.
- Stessa brevità, stesso stile, stessa chiusura «A presto.». Gli esempi marcati [3★] sono i più vicini a questo caso.`;

const NOTA_3_STELLE_EN = `NOTE: this is a 3-STAR review, a middling rating — NOT a positive one.
- Thank them for the feedback, not for "the positive rating".
- If the customer reports a problem, acknowledge it in half a sentence, without justifying and without promising anything.
- If they appreciated something, pick that up.
- Same brevity, same style, same closing "See you soon.". The examples marked [3★] are the closest to this case.`;

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
  opts: { escludiEsempio?: string; evita?: string } = {},
): Promise<Suggerimento> {
  const commento = (r.commento ?? "").trim();
  if (!commento) throw new Error("Nessun commento: per una recensione senza testo vale «Grazie.».");

  // Il nome: ultimo ripiego, deciso dall'IA (con cache) invece che da una
  // lista scritta a mano — scatta di rado qui, dato che un commento breve
  // ma non vuoto quasi sempre basta da solo a riconoscere la lingua.
  const lingua = await linguaRispostaIA(r.lingua ?? "", commento, r.nome);
  const italiano = lingua !== "altra"; // "it" e "ignota" → italiano, come nel resto dell'app
  const linguaEsempi = italiano ? "it" : "en";

  const treStelle = r.stelle === 3;
  const esempiDi = (tipo: NonNullable<Parameters<typeof esempiPerContesto>[0]["tipo"]>) =>
    esempiPerContesto({
      tipo,
      lingua: linguaEsempi,
      limite: ESEMPI_NEL_PROMPT,
      escludi: opts.escludiEsempio ? [opts.escludiEsempio] : undefined,
    });
  const [blocchi, esempi] = await Promise.all([
    blocchiPerContesto(),
    // Le 3★ vere di Stefania sono poche (11 in un anno): vanno per PRIME, e le
    // positive completano il campione per lo stile. Fuori dalle 3★, solo positive.
    treStelle
      ? Promise.all([esempiDi("neutra"), esempiDi("positiva-con-testo")]).then(([n, p]) =>
          [...n, ...p].slice(0, ESEMPI_NEL_PROMPT),
        )
      : esempiDi("positiva-con-testo"),
  ]);

  const contesto = blocchi.map((b) => `## ${b.titolo}\n${b.testo}`).join("\n\n");
  const system = [
    contesto,
    italiano ? ISTRUZIONI_IT : ISTRUZIONI_EN,
    treStelle ? (italiano ? NOTA_3_STELLE_IT : NOTA_3_STELLE_EN) : "",
    esempi.length > 0 ? bloccoEsempi(esempi, italiano) : "",
  ]
    .filter((p) => p.trim())
    .join("\n\n");

  const stelle = r.stelle ? `${r.stelle}` : "—";
  let utente = italiano
    ? `Recensione a cui rispondere:\nCliente: ${r.nome || "(senza nome)"}\nSede: ${r.sede || "(non indicata)"}\nPunteggio: ${stelle}/5\nCommento: «${commento}»`
    : `Review to reply to:\nCustomer: ${r.nome || "(no name)"}\nBranch: ${r.sede || "(not specified)"}\nRating: ${stelle}/5\nComment: «${commento}»`;

  // «Rigenera»: senza questa nota il modello, a parità di richiesta, riproporrebbe
  // quasi sempre la stessa frase e il pulsante sembrerebbe non funzionare.
  if (opts.evita?.trim()) {
    utente += italiano
      ? `\n\nAvevamo già proposto questa risposta:\n«${opts.evita.trim()}»\nScrivine una DIVERSA: cambia la frase centrale (un altro aspetto da riprendere, o un altro modo di dirlo). Apertura e chiusura restano quelle di sempre.`
      : `\n\nWe already proposed this reply:\n«${opts.evita.trim()}»\nWrite a DIFFERENT one: change the middle sentence (another aspect to pick up, or another way to say it). Keep the usual greeting and closing.`;
  }

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
