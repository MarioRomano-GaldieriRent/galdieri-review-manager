// Estrazione dei dati di una recensione dal corpo dell'email inviata da Zapier.
//
// Formato atteso (email "NUOVA RECENSIONE GOOGLE <sede>"):
//   Nome:Oezi Karaca
//   Commento:(Translated by Google) Uncomplicated, fast car rental
//   (Original)
//   Unkomplizierte schnelle Autovermietung
//   Punteggio:5 Stelle
//   ------------------------------------------------------------------
//   Visit this link to stop these emails: https://zapier.com/...

/** Converte l'HTML dell'email in testo leggibile. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ParsedReview = {
  name: string;
  comment: string;
  /** Punteggio 1-5, null se non riconosciuto. */
  score: number | null;
  scoreLabel: string;
};

/** Rimuove il piè di pagina di Zapier e le righe di separazione. */
function stripFooter(s: string): string {
  return s
    .split(/\n-{5,}/)[0]
    .replace(/Visit this link to stop these emails:.*/gis, "")
    .trim();
}

/**
 * Estrae Nome / Commento / Punteggio. Ritorna null se il corpo non contiene
 * una recensione (es. notifiche di ticket Freshdesk).
 */
export function parseReview(bodyText: string): ParsedReview | null {
  const text = bodyText.replace(/\r\n/g, "\n");

  const nameMatch = text.match(/^[ \t]*Nome[ \t]*:[ \t]*(.*)$/im);
  const scoreMatch = text.match(/^[ \t]*Punteggio[ \t]*:[ \t]*(.*)$/im);
  if (!nameMatch || !scoreMatch) return null;

  // Il commento va da "Commento:" fino alla riga "Punteggio:".
  const commentMatch = text.match(
    /^[ \t]*Commento[ \t]*:[ \t]*([\s\S]*?)(?=^[ \t]*Punteggio[ \t]*:)/im,
  );

  const scoreLabel = stripFooter(scoreMatch[1]).trim();
  const scoreNum = scoreLabel.match(/(\d+([.,]\d+)?)/);
  const score = scoreNum ? Math.round(Number(scoreNum[1].replace(",", "."))) : null;

  return {
    name: nameMatch[1].trim() || "(senza nome)",
    comment: commentMatch ? stripFooter(commentMatch[1]).trim() : "",
    score: score !== null && score >= 1 && score <= 5 ? score : null,
    scoreLabel,
  };
}

/**
 * Il commento di Google spesso contiene traduzione + originale:
 *   (Translated by Google) testo tradotto
 *   (Original)
 *   testo originale
 */
export function splitTranslation(comment: string): { translated: string; original: string } {
  const c = comment.trim();

  // Formato A: (Translated by Google) <traduzione> (Original) <originale>
  const a = c.match(/^\(Translated by Google\)\s*([\s\S]*?)\s*\(Original\)\s*([\s\S]*)$/i);
  if (a) return { translated: a[1].trim(), original: a[2].trim() };

  // Formato B: <originale> (Translated by Google) <traduzione>
  const b = c.match(/^([\s\S]*?)\s*\(Translated by Google\)\s*([\s\S]*)$/i);
  if (b && b[1].trim()) return { translated: b[2].trim(), original: b[1].trim() };

  return { translated: c, original: "" };
}

/** Ricava la sede dall'oggetto: "NUOVA RECENSIONE GOOGLE LAMEZIA TERME" -> "LAMEZIA TERME". */
export function locationFromSubject(subject: string, subjectContains: string): string {
  const cleaned = subject
    .replace(/^\s*(ticket\s+\w+\s*[-–:]\s*)?((r|re|i|fw|fwd|rif)\s*:\s*)*/i, "")
    .trim();
  const idx = cleaned.toUpperCase().indexOf(subjectContains.toUpperCase());
  if (idx === -1) return "";
  return cleaned.slice(idx + subjectContains.length).trim().replace(/^[-–:]\s*/, "");
}
