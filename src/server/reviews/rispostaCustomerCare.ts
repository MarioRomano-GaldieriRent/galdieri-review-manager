import { getConversation, getMessage, listInbox } from "@/server/graph/client";
import {
  chiaviConEscalation,
  elencoInAttesa,
  registraInoltro,
  salvaRisposta,
} from "@/server/db/escalation";
import { chiaviArchiviateFra, correggiDataArrivo } from "@/server/db/recensioni";
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
  const testo = togliSalutoInterno(
    dopo
      .slice(0, fine)
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  return testo.length >= 10 ? { testo, ticket } : null;
}

/**
 * Una riga fatta SOLO del saluto di Cherubina a Stefania: «grazie», «grazie
 * mille», con la punteggiatura e gli spazi che capitano («grazie ,»). Ammessi
 * anche i caratteri invisibili (spazio a larghezza zero) che Outlook lascia
 * davanti: su «edwin blok» c'erano.
 */
const SALUTO_INTERNO = /^[\s​-‍﻿]*grazie(\s+mille)?[\s,.;:!​-‍﻿]*$/i;

/**
 * Toglie dal FONDO della risposta il saluto interno a Stefania.
 *
 * Cherubina chiude la mail così:
 *     …we look forward to welcoming you back in the future.
 *
 *     grazie ,
 *
 *     Cherubina Panico
 * La firma si tagliava già, il «grazie» subito sopra no — il marcatore chiedeva
 * «grazie» e «Cherubina Panico» attaccati, e bastava una virgola o una riga
 * vuota in mezzo per saltarlo. Così «grazie ,» è finito pubblicato su Google
 * sotto la risposta a Nicolas Wohlfarth (15/9/2026), e prima ancora sotto altre.
 *
 * Solo righe INTERE e solo in FONDO: un «grazie» dentro una frase rivolta al
 * cliente non si tocca. Sulle 37 risposte del customer care in archivio le
 * righe finali così sono 11 e sono tutte il saluto interno; quando la risposta
 * al cliente è in italiano Cherubina la chiude sempre con una frase intera
 * («La ringraziamo nuovamente per il Suo riscontro…»), mai con «Grazie» da solo.
 */
export function togliSalutoInterno(testo: string): string {
  const righe = testo.split("\n");
  while (righe.length > 0 && (righe[righe.length - 1].trim() === "" || SALUTO_INTERNO.test(righe[righe.length - 1]))) {
    righe.pop();
  }
  return righe.join("\n").trim();
}

/**
 * Il saluto con cui si apre una risposta AL CLIENTE, nelle lingue in cui
 * risponde il customer care. Il lookahead al posto di \b: con le lettere
 * accentate («chère») \b non vede il confine della parola.
 *
 * «Ciao» manca apposta: è come Cherubina scrive a STEFANIA («Ciao Stefania,
 * ticket …»); ai clienti scrive sempre «Gentile» o «Dear». Un testo che si
 * apre con «Ciao» è più facile che sia per lei che per il cliente.
 */
const SALUTO_AL_CLIENTE =
  /^(dear|gentil[ei]|gent\.?\s?m[oa]|egregi[oa]|car[oa]|buongiorno|buonasera|salve|hello|hi|good\s+(morning|afternoon|evening)|bonjour|bonsoir|madame|monsieur|cher|chère|hallo|guten\s+(tag|morgen)|sehr\s+geehrte[rs]?|liebe[rs]?|estimad[oa]s?|hola|querid[oa]s?|beste|geachte|goedendag)(?=[\s,.:;!]|$)/i;

/** Ciò che in una risposta al cliente non deve mai comparire: roba fra colleghi. */
const PAROLE_INTERNE =
  /\bstefania\b|\bcherubina\b|\btick\w*\s*[:#]?\s*\d{3,}|\bti\s+(giro|inoltro|mando)\b|\bper\s+conoscenza\b/i;

/**
 * Si può pubblicare questo testo del customer care SENZA che una persona lo
 * rilegga? null = sì; altrimenti il motivo, da scrivere nella segnalazione.
 *
 * Serve al pilota, che pubblica da solo la risposta di Cherubina alle negative.
 * Il pericolo è concreto: la mail di Cherubina è indirizzata a Stefania, e ciò
 * che l'estrazione isola può non essere il testo per il cliente. Tarato sulle
 * 47 risposte in archivio al 22/9/2026: 46 si aprono con «Dear …» o «Gentile …»,
 * fra 290 e 1.563 caratteri. La 47ª comincia con «tickte 58650 Dear David»:
 * Cherubina ha scritto male «ticket», l'estrazione non l'ha riconosciuto e il
 * numero sarebbe finito su Google. È esattamente ciò che qui si ferma.
 *
 * Nel dubbio si ferma: una risposta buona trattenuta costa un clic a Stefania,
 * una nota interna pubblicata resta sotto la recensione davanti a tutti.
 */
export function motivoPerNonPubblicare(testo: string, autore?: string): string | null {
  // Gli invisibili che Outlook lascia in testa (su «Dear Nora» c'erano).
  const t = (testo || "").replace(/^[\s​-‍﻿]+/, "").trim();
  if (t.length < 80) return `il testo è troppo corto per essere una risposta (${t.length} caratteri)`;
  if (t.length > 4000) return `il testo supera il limite di Google (${t.length} caratteri su 4.000)`;
  if (!SALUTO_AL_CLIENTE.test(t)) {
    return `non si apre con un saluto al cliente: comincia con «${t.slice(0, 40).replace(/\s+/g, " ")}…»`;
  }
  const interno = t.match(PAROLE_INTERNE);
  if (interno) return `contiene «${interno[0]}», che è una cosa fra colleghi e non per il cliente`;
  if (autore) {
    const nome = nomeNelSaluto(t);
    if (nome && !nomeCombacia(nome, autore)) {
      return `il saluto è per «${nome}» ma la recensione è di «${autore}»: la risposta potrebbe essere agganciata al cliente sbagliato`;
    }
  }
  return null;
}

/** Minuscolo e senza accenti, per confrontare nomi («Sören» = «soren»). */
const piano = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Titoli di cortesia da saltare prima del nome, e parole che non sono un nome. */
// Un titolo si toglie anche quando è l'ultima parola («Bonjour Madame,»):
// altrimenti «Madame» passerebbe per un nome e bloccherebbe una risposta buona.
const TITOLI =
  /^(?:(?:mr|mrs|ms|miss|mx|dr|sig|sig\.ra|sigg|signor|signora|sig\.na|dott|dott\.ssa|herr|frau|madame|monsieur|mme|mlle|m|se[nñ]or|se[nñ]ora|sr|sra)(?:\.?\s+|\.?$))+/i;
const GENERICI = new Set([
  "customer", "cliente", "client", "clienti", "kunde", "kundin", "guest", "ospite",
  "sir", "madam", "madame", "monsieur", "signore", "signora", "signori", "all", "tutti",
]);

/**
 * Il nome del cliente nel saluto («Dear Mr. Geoff Middle,» → «Geoff Middle»),
 * o null se non si legge. Il saluto va fino alla prima virgola o al primo a capo.
 */
function nomeNelSaluto(t: string): string | null {
  const m = t.match(SALUTO_AL_CLIENTE);
  if (!m) return null;
  const resto = t.slice(m[0].length).replace(/^\s+/, "");
  const fino = resto.split(/[,\n!:]/)[0] ?? "";
  const nome = fino.replace(TITOLI, "").trim();
  return nome && nome.length <= 40 ? nome : null;
}

/**
 * Il nome del saluto è quello dell'autore? Basta una parola di almeno tre
 * lettere in comune («Mr. McDowell» ↔ «Alan McDowell»). Se il saluto non ha
 * parole così («Dear C», «Dear D.») o usa un generico («Dear Customer»), non si
 * può giudicare e NON si blocca: sulle 47 risposte vere del 22/9/2026 il nome
 * combacia in 44, è indecidibile in 3 e non discorda mai.
 */
function nomeCombacia(nome: string, autore: string): boolean {
  const parole = piano(nome)
    .split(/[\s.\-'’]+/)
    .filter((w) => w.length >= 3 && !GENERICI.has(w));
  if (parole.length === 0) return true;
  const a = piano(autore);
  return parole.some((w) => a.includes(w));
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
 * ha già pubblicato, e chi è stato archiviato a mano. Il testo NON viene
 * pubblicato da qui: finisce nel riquadro, e resta all'operatore approvarlo —
 * anche perché una mail del customer care può essere una nota interna e non
 * una risposta per il cliente.
 *
 * `haRisposta` NON è fra i motivi per saltare, e non deve tornarci: per queste
 * recensioni è vero per costruzione, perché l'inoltro a mano di Stefania è una
 * mail Galdieri nel thread. Contarlo come «già chiusa» scartava proprio i casi
 * per cui questa funzione esiste. Il rischio opposto — riproporre una che
 * Stefania ha già pubblicato a mano su Google — non diventa un doppio invio:
 * la coda di Google mostra solo le recensioni ancora senza risposta, e nella
 * lista una card già risposta non ha «Rispondi», quindi il robot non clicca e
 * lo dice («ha già una risposta»). Nel peggiore dei casi la recensione compare
 * una volta in «Da approvare» e si archivia.
 */
export async function registraRitorniCustomerCare(recensioni: Recensione[]): Promise<number> {
  const candidate = recensioni.filter((r) => r.rispostaCustomerCare);
  if (candidate.length === 0) return 0;

  const [conEscalation, pubblicate, archiviate] = await Promise.all([
    chiaviConEscalation(),
    chiaviPubblicate(),
    chiaviArchiviateFra(candidate.map((r) => r.chiave)),
  ]);

  let registrate = 0;
  for (const r of candidate) {
    if (conEscalation.has(r.chiave) || pubblicate.has(r.chiave) || archiviate.has(r.chiave)) continue;
    const rep = r.rispostaCustomerCare!;
    // La data dell'inoltro è quella VERA solo quando il portale l'ha fatto lui.
    // Qui non la sappiamo — l'inoltro è avvenuto in Outlook — e scriverne una
    // finta renderebbe bugiardo il registro: si tiene la data della risposta,
    // che è l'unico istante certo di questa lavorazione.
    await registraInoltro(r, {
      ticketId: rep.ticket,
      operatoreId: SISTEMA,
      origine: "posta",
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
