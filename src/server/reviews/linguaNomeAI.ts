import Anthropic from "@anthropic-ai/sdk";
import { claude, isClaudeConfigured, modelloClaude } from "@/server/ai/claude";
import { leggiLinguaNome, salvaLinguaNome, type LinguaDecisa } from "@/server/db/linguaNomi";
import { nomeSembraItaliano, riconosciLingua } from "./lingua";

// Decide "italiano o straniero?" guardando il NOME, chiedendolo all'IA —
// invece di una lista scritta a mano da tenere aggiornata per sempre.
//
// Usato SOLO come ultimo ripiego (vedi linguaRispostaIA sotto): quando né la
// lingua rilevata da Azure né il testo della recensione dicono niente, tipico
// delle 5★ senza commento. Le sedi sono per lo più aeroportuali: il grosso di
// quelle recensioni è di clienti stranieri, e prima finivano TUTTE in
// italiano ("Grazie."), a prescindere da chi le avesse lasciate.
//
// Ogni nome si chiede a Claude UNA volta sola: la risposta resta in cache
// (collezione lingua_nomi) e i giri successivi — stesso cliente, o un altro
// con lo stesso nome — non ripagano la domanda. Se l'IA non è configurata o
// la chiamata fallisce (rete, rate limit), si ripiega SILENZIOSAMENTE
// sull'euristica per prenomi/cognomi noti (nomeSembraItaliano): non deve mai
// bloccare, né rallentare visibilmente, una risposta da pubblicare.

/**
 * "IT" o "EN" dal nome del cliente, chiesto a Claude. Una sola parola in
 * uscita, pochi token: il costo di una chiamata è trascurabile, e la cache lo
 * azzera dalla seconda volta in poi sullo stesso nome.
 */
async function chiediAllaIA(nome: string): Promise<LinguaDecisa> {
  const risposta = await claude().messages.create({
    model: modelloClaude(),
    max_tokens: 8,
    // effort basso: è una classificazione di una parola, non un ragionamento.
    output_config: { effort: "low" },
    system:
      'Classifichi nomi di persona per un\'agenzia di noleggio auto in Italia. ' +
      'Rispondi SOLO con "IT" oppure "EN", una parola sola, senza punteggiatura ' +
      'e senza spiegazioni. "IT" se nome e cognome sono di origine italiana; ' +
      '"EN" per qualunque altra origine (inglese, francese, tedesca, spagnola, ' +
      'slava, ecc.) o se non riesci a deciderlo con sicurezza.',
    messages: [{ role: "user", content: `Nome del cliente: ${nome}` }],
  });

  const testo = risposta.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .toUpperCase();

  return testo.startsWith("IT") ? "it" : "altra";
}

/**
 * "it" o "altra" dal nome, con cache persistita e ripiego sull'euristica.
 * Non solleva mai.
 */
export async function linguaDalNomeIA(nome: string): Promise<LinguaDecisa> {
  const pulito = (nome ?? "").trim();
  if (!pulito) return "altra";

  const inCache = await leggiLinguaNome(pulito);
  if (inCache) return inCache;

  if (!isClaudeConfigured()) return nomeSembraItaliano(pulito) ? "it" : "altra";

  try {
    const lingua = await chiediAllaIA(pulito);
    await salvaLinguaNome(pulito, lingua, "ai");
    return lingua;
  } catch (e) {
    console.error(`[lingua-nome] Claude non ha risposto per «${pulito}», ripiego sull'euristica:`, e);
    return nomeSembraItaliano(pulito) ? "it" : "altra";
  }
}

/**
 * Come linguaRisposta (reviews/lingua.ts), ma quando serve il ripiego sul
 * nome lo decide l'IA invece della whitelist — vedi linguaDalNomeIA sopra.
 * Azure e il testo restano la fonte primaria, IDENTICA a prima: il nome (IA o
 * whitelist) entra in gioco solo quando nessuno dei due ha detto niente.
 *
 * Il tipo di ritorno è "it" | "altra" (mai "ignota", a differenza del tipo
 * Lingua più generale): a questo punto una decisione c'è sempre, presa
 * dall'IA o dall'euristica di riserva.
 */
export async function linguaRispostaIA(
  linguaRilevata: string,
  testoOriginale: string,
  nomeCliente = "",
): Promise<LinguaDecisa> {
  const codice = (linguaRilevata ?? "").trim().toLowerCase();
  if (codice) return codice === "it" ? "it" : "altra";
  const dalTesto = riconosciLingua(testoOriginale);
  if (dalTesto === "it" || dalTesto === "altra") return dalTesto;
  return linguaDalNomeIA(nomeCliente);
}
