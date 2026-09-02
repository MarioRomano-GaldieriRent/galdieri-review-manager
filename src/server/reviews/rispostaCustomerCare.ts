import { getConversation, getMessage, listInbox } from "@/server/graph/client";
import { elencoInAttesa, salvaRisposta } from "@/server/db/escalation";
import { htmlToText } from "./parse";

// Recupero della risposta del customer care a una recensione negativa inoltrata.
//
// Cherubina risponde all'inoltro; la mail torna nella casella così:
//   Da:      customer.care@galdierirent.it
//   Oggetto: Re: I: <oggetto della recensione>
//   Corpo:
//     Ciao Stefania,
//     ticket <N>
//     <TESTO DA PUBBLICARE SU GOOGLE>        ← ciò che ci serve
//     Grazie / Cherubina Panico / firma      ← da tagliare
//     Il <data> … ha scritto: <inoltro + recensione citati>   ← da tagliare
//
// Qui si isola il testo da pubblicare e si legge il numero di ticket.

/** Marcatori che segnano la FINE della risposta (firma, citazione, footer). */
const FINE_RISPOSTA: RegExp[] = [
  /\n\s*grazie\s*\n\s*cherubina\s+panico/i,
  /\n\s*cherubina\s+panico/i,
  /\n\s*coordinatrice\s+customer\s+care/i,
  /\n\s*il\s+\S+[,.]?\s+\d.*\bha\s+scritto\s*:/i, // "Il Mar, 25 Ago … ha scritto:"
  /\n\s*da\s*:\s[\s\S]*?\binviato\s*:/i, // blocco "Da: … Inviato: …" (Outlook)
  /\n-{4,}/,
  /\bground\s+s\.?\s?r\.?\s?l\./i,
  /www\.galdierirent\.it/i,
  /visit this link/i,
  /si trasmette per quanto di competenza/i,
];

/**
 * Isola il testo della risposta dal corpo (già testo) della mail del customer
 * care. Ritorna testo + numero ticket, oppure null se non riconosce una risposta.
 */
export function estraiRisposta(corpoTesto: string): { testo: string; ticket: number | null } | null {
  const t = (corpoTesto || "").replace(/\r/g, "");
  // "ticket <N>" è il link a Freshdesk; la risposta comincia subito dopo.
  const mTk = t.match(/ticket[ey]*\s*[:#]?\s*(\d{3,})/i);
  const ticket = mTk ? Number(mTk[1]) : null;
  const dopo = mTk
    ? t.slice(mTk.index! + mTk[0].length)
    : t.replace(/^\s*ciao[^\n]*\n/i, ""); // fallback: dopo "Ciao Stefania,"

  // Taglia alla prima firma/citazione/footer.
  let fine = dopo.length;
  for (const re of FINE_RISPOSTA) {
    const m = dopo.match(re);
    if (m && m.index !== undefined && m.index < fine) fine = m.index;
  }
  const testo = dopo
    .slice(0, fine)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return testo.length >= 10 ? { testo, ticket } : null;
}

/** È una notifica automatica di Freshdesk, non una risposta vera? */
function eNotifica(subject: string): boolean {
  const s = subject.toLowerCase();
  return s.startsWith("ticket creato") || s.startsWith("ticket risolto") || s.startsWith("ticket chiuso");
}

/**
 * Cerca la risposta del customer care nella CONVERSAZIONE dell'inoltro (il
 * conversationId catturato quando abbiamo inoltrato). Scorre i messaggi dal più
 * recente e prende il primo da customer.care@ che non sia una notifica
 * automatica e da cui si estrae un testo. Sola lettura.
 */
export async function cercaRispostaInConversazione(
  conversationId: string,
  mailbox?: string,
): Promise<{ testo: string; ticket: number | null; quando: string } | null> {
  if (!conversationId) return null;
  const messaggi = await getConversation(conversationId, mailbox);
  for (const m of [...messaggi].reverse()) {
    if (!m.fromAddress.toLowerCase().includes("customer.care")) continue;
    if (eNotifica(m.subject)) continue;
    const testo = m.bodyIsHtml ? htmlToText(m.bodyContent) : m.bodyContent;
    const est = estraiRisposta(testo);
    if (est) return { ...est, quando: m.receivedDateTime };
  }
  return null;
}

/**
 * Per ogni recensione «in attesa», cerca la risposta del customer care nella
 * posta e, se la trova, la salva (la voce passa a «pronta» e ricompare in «Da
 * approvare» precompilata). Best-effort: un errore su una non blocca le altre.
 * Ritorna quante ne ha trovate. Sola lettura sulla posta.
 */
export async function aggiornaAttese(mailbox?: string): Promise<number> {
  const attese = await elencoInAttesa();
  let trovate = 0;
  for (const e of attese) {
    try {
      const rep = await cercaRispostaPerRecensione({ originale: e.originale, idGoogle: e.idGoogle }, mailbox);
      if (rep) {
        await salvaRisposta(e.chiave, rep.testo, rep.ticket, rep.quando);
        trovate++;
      }
    } catch {
      // best-effort: si riproverà al prossimo giro
    }
  }
  return trovate;
}

const piatto = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Cerca nella casella la risposta del customer care a UNA recensione, senza
 * dipendere dal nome (che può essere corto, es. «D»): usa un frammento del
 * COMMENTO originale, che è SEMPRE presente nel testo citato della risposta.
 * Filtra le mail da customer.care@ (escluse le notifiche automatiche) e verifica
 * che il commento compaia nel citato prima di estrarre. Sola lettura.
 */
export async function cercaRispostaPerRecensione(
  rec: { originale?: string; idGoogle?: string | null },
  mailbox?: string,
): Promise<{ testo: string; ticket: number | null; quando: string } | null> {
  const commento = piatto(rec.originale || "");
  // Termine distintivo per la ricerca full-text: l'ID Google se c'è, altrimenti
  // una porzione del commento (parole lunghe, per essere selettivi).
  const parole = commento.split(" ").filter((w) => w.length >= 4).slice(0, 8).join(" ");
  const termine = (rec.idGoogle && rec.idGoogle.length >= 10 ? rec.idGoogle : parole).trim();
  if (termine.length < 6) return null;

  const { messages } = await listInbox({ mailbox, search: termine, top: 15 });
  for (const m of messages) {
    if (!m.fromAddress.toLowerCase().includes("customer.care")) continue;
    if (eNotifica(m.subject)) continue;
    const full = await getMessage(m.id, mailbox);
    const testo = full.bodyIsHtml ? htmlToText(full.bodyContent) : full.bodyContent;
    // Conferma che sia PROPRIO questa recensione: un pezzo del commento deve
    // comparire nel citato (evita di agganciare la risposta di un altro).
    const sonda = commento.slice(0, 40);
    if (sonda && !piatto(testo).includes(sonda)) continue;
    const est = estraiRisposta(testo);
    if (est) return { ...est, quando: m.receivedDateTime };
  }
  return null;
}
