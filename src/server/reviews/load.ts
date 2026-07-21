import { searchMessages, type MailDetail } from "@/server/graph/client";
import { htmlToText, locationFromSubject, parseReview, splitTranslation } from "./parse";
import { activeMailbox, type Label } from "@/server/settings";
import { translateToItalian } from "@/server/translate";

// Caricamento delle recensioni dalla posta: sorgente unica condivisa dal
// pannello Recensioni e dal pannello Automazioni, così i due vedono
// esattamente gli stessi dati.

export type Recensione = {
  /** Id della conversazione: identifica la recensione in modo stabile. */
  chiave: string;
  nome: string;
  stelle: number | null;
  punteggioTesto: string;
  /** Testo scritto davvero dal cliente. */
  originale: string;
  /** Versione italiana, se la traduzione è attiva. */
  italiano: string | null;
  giaItaliano: boolean;
  lingua: string;
  /** Traduzione inglese aggiunta da Google, quando presente. */
  ingleseDiGoogle: string;
  sede: string;
  oggetto: string;
  ricevutaIl: string;
  messaggioId: string;
  numeroMessaggi: number;
  haRisposta: boolean;
  risolto: boolean;
};

/** Il testo da mostrare e su cui ragionare: italiano se c'è, altrimenti l'originale. */
export function testoRecensione(r: Recensione): string {
  return (r.italiano ?? r.originale).trim();
}

export function haTesto(r: Recensione): boolean {
  return testoRecensione(r).length > 0;
}

/** Raggruppa i messaggi per conversazione e ne ricava una recensione per flusso. */
function raggruppa(messaggi: MailDetail[], label: Label) {
  const perConversazione = new Map<string, MailDetail[]>();
  for (const m of messaggi) {
    const key = m.conversationId || m.id;
    const arr = perConversazione.get(key);
    if (arr) arr.push(m);
    else perConversazione.set(key, [m]);
  }

  const grezze: {
    chiave: string;
    msg: MailDetail;
    nome: string;
    commento: string;
    stelle: number | null;
    punteggioTesto: string;
    sede: string;
    numeroMessaggi: number;
    haRisposta: boolean;
    risolto: boolean;
  }[] = [];

  for (const [chiave, gruppo] of perConversazione) {
    // Il messaggio che contiene davvero i campi della recensione; si preferisce
    // l'originale di Zapier rispetto alle risposte che lo citano.
    let best: { msg: MailDetail; parsed: NonNullable<ReturnType<typeof parseReview>> } | null = null;
    for (const m of gruppo) {
      const parsed = parseReview(m.bodyIsHtml ? htmlToText(m.bodyContent) : m.bodyContent);
      if (!parsed) continue;
      const isZapier = m.fromAddress.toLowerCase().includes("zapier");
      if (!best || (isZapier && !best.msg.fromAddress.toLowerCase().includes("zapier"))) {
        best = { msg: m, parsed };
      }
    }
    if (!best) continue;

    grezze.push({
      chiave,
      msg: best.msg,
      nome: best.parsed.name,
      commento: best.parsed.comment,
      stelle: best.parsed.score,
      punteggioTesto: best.parsed.scoreLabel,
      sede: locationFromSubject(best.msg.subject, label.subjectContains),
      numeroMessaggi: gruppo.length,
      risolto: gruppo.some((m) => /ticket\s+risolto/i.test(m.subject)),
      haRisposta: gruppo.some((m) => {
        const a = m.fromAddress.toLowerCase();
        return (
          a.endsWith("@galdierirent.it") && !a.startsWith("customer.care") && !a.includes("zapier")
        );
      }),
    });
  }

  return grezze.sort(
    (a, b) =>
      new Date(b.msg.receivedDateTime).getTime() - new Date(a.msg.receivedDateTime).getTime(),
  );
}

export async function caricaRecensioni(
  label: Label,
  opts: { top?: number } = {},
): Promise<{ recensioni: Recensione[]; analizzate: number }> {
  const messaggi = await searchMessages({
    subjectContains: label.subjectContains,
    fromContains: label.fromContains,
    top: opts.top ?? 50,
    mailbox: await activeMailbox(),
  });

  const grezze = raggruppa(messaggi, label);

  // Google allega spesso anche la propria traduzione inglese: si tiene da parte
  // il testo del cliente e si traduce quello.
  const parti = grezze.map((g) => splitTranslation(g.commento));
  const originali = parti.map((p) => p.original || p.translated);
  const traduzioni = await translateToItalian(originali);

  const recensioni: Recensione[] = grezze.map((g, i) => ({
    chiave: g.chiave,
    nome: g.nome,
    stelle: g.stelle,
    punteggioTesto: g.punteggioTesto,
    originale: originali[i],
    italiano: traduzioni[i]?.italian ?? null,
    giaItaliano: traduzioni[i]?.alreadyItalian ?? false,
    lingua: traduzioni[i]?.detected ?? "",
    ingleseDiGoogle: parti[i].original ? parti[i].translated : "",
    sede: g.sede,
    oggetto: g.msg.subject,
    ricevutaIl: g.msg.receivedDateTime,
    messaggioId: g.msg.id,
    numeroMessaggi: g.numeroMessaggi,
    haRisposta: g.haRisposta,
    risolto: g.risolto,
  }));

  return { recensioni, analizzate: messaggi.length };
}
