import { getConversation, getMessage, listInbox } from "@/server/graph/client";
import {
  chiaviConEscalation,
  elencoInAttesa,
  registraInoltro,
  salvaRisposta,
} from "@/server/db/escalation";
import { chiaviGiaChiuse, correggiDataArrivo } from "@/server/db/recensioni";
import { chiaviPubblicate } from "@/server/db/pubblicazioni";
import { htmlToText } from "./parse";
import type { Recensione } from "./load";

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

/**
 * È una notifica automatica di Freshdesk, non una risposta vera?
 *
 * Freshdesk mette lo stato del ticket in testa all'oggetto — e non sempre in
 * italiano: nella casella ci sono 98 «Ticket Risolto» e 3 «Ticket Closed».
 * Finché qui c'era solo l'elenco italiano, una notifica inglese passava per una
 * risposta di Cherubina: il suo testo («Your ticket … has been closed») sarebbe
 * finito nel riquadro da pubblicare su Google.
 */
export function eNotifica(subject: string): boolean {
  return /^\s*ticket\s+(creato|aperto|risolto|chiuso|riaperto|aggiornato|created|opened|resolved|closed|reopened|updated)\b/i.test(
    subject || "",
  );
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

/** Chi risulta aver registrato la voce: non un operatore, il sistema. */
const SISTEMA = 1;

/**
 * Riconosce i ritorni del customer care su inoltri fatti A MANO, fuori dal
 * portale, e li porta nel flusso normale: voce «pronta», riquadro
 * precompilato col testo di Cherubina in «Da approvare».
 *
 * Perché serve. `aggiornaAttese` aggiorna solo le escalation che il portale ha
 * registrato lui. Ma per mesi gli inoltri li ha fatti Stefania a mano, e quelle
 * risposte tornano adesso: nel portale non esiste nessuna voce da aggiornare.
 * Il risultato era una recensione che compariva in coda come «mai gestita»
 * proprio nel momento in cui la risposta era arrivata — è il caso di viktoria
 * koe e edwin blok (inoltrate a mano il 25 agosto, risposte il 9 settembre).
 *
 * Il segnale è la risposta stessa, letta dal thread durante l'ingest: non
 * «Ticket Risolto», che è vero per quasi tutte le recensioni e non dice se
 * qualcuno ha davvero scritto al cliente. Vale a ogni livello di stelle —
 * conta che Cherubina abbia risposto, non quante stelle avesse la recensione.
 *
 * Non tocca: chi ha già una voce escalation (ha la sua storia), chi il portale
 * ha già pubblicato, e chi è già stato chiuso a mano. Il testo NON viene
 * pubblicato da qui: finisce nel riquadro, e resta all'operatore approvarlo —
 * anche perché una mail del customer care può essere una nota interna e non
 * una risposta per il cliente.
 */
export async function registraRitorniCustomerCare(recensioni: Recensione[]): Promise<number> {
  const candidate = recensioni.filter((r) => r.rispostaCustomerCare);
  if (candidate.length === 0) return 0;

  const [conEscalation, pubblicate, giaChiuse] = await Promise.all([
    chiaviConEscalation(),
    chiaviPubblicate(),
    chiaviGiaChiuse(candidate.map((r) => r.chiave)),
  ]);

  let registrate = 0;
  for (const r of candidate) {
    if (conEscalation.has(r.chiave) || pubblicate.has(r.chiave) || giaChiuse.has(r.chiave)) continue;
    const rep = r.rispostaCustomerCare!;
    // La data dell'inoltro è quella VERA solo quando il portale l'ha fatto lui.
    // Qui non la sappiamo — l'inoltro è avvenuto in Outlook — e scriverne una
    // finta renderebbe bugiardo il registro: si tiene la data della risposta,
    // che è l'unico istante certo di questa lavorazione.
    await registraInoltro(r, {
      ticketId: rep.ticket,
      operatoreId: SISTEMA,
      inoltrataIl: new Date(rep.quando),
    });
    await salvaRisposta(r.chiave, rep.testo, rep.ticket, rep.quando);
    await correggiData(r.chiave);
    registrate++;
  }
  return registrate;
}

/**
 * Rimette la data di arrivo giusta leggendo il thread INTERO.
 *
 * Queste recensioni si scoprono solo perché il customer care ha risposto, e la
 * risposta arriva settimane dopo: l'email originale è ormai fuori dalla
 * finestra di posta che l'ingest legge, quindi la recensione viene schedata con
 * la data della risposta. Silvia Endrizzi è del 25 agosto e risultava del 7
 * settembre — sullo schermo sembrava nuova, e nelle statistiche cadeva nella
 * coorte sbagliata.
 *
 * `getConversation` invece il thread ce l'ha tutto, email originale compresa:
 * la data buona è quella del messaggio più vecchio. È UNA chiamata, e solo alla
 * prima registrazione di ogni ritorno — non a ogni caricamento. Se fallisce non
 * si tocca niente: una data vecchia e sbagliata è meglio di una registrazione
 * persa.
 */
async function correggiData(chiave: string, mailbox?: string): Promise<void> {
  try {
    const messaggi = await getConversation(chiave, mailbox);
    if (messaggi.length === 0) return;
    const prima = new Date(
      Math.min(...messaggi.map((m) => new Date(m.receivedDateTime).getTime())),
    );
    if (Number.isNaN(prima.getTime())) return;
    if (await correggiDataArrivo(chiave, prima))
      console.log(`[ritorni] data di «${chiave.slice(0, 12)}…» riportata al ${prima.toISOString()}.`);
  } catch (e) {
    console.warn("[ritorni] data non corretta:", e instanceof Error ? e.message : e);
  }
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
