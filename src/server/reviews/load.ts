import { salvaRecensioni } from "@/server/db/recensioni";
import { searchMessages, type MailDetail } from "@/server/graph/client";
import { htmlToText, locationFromSubject, parseReview, splitTranslation } from "./parse";
import { eNotifica, estraiRisposta, registraRitorniCustomerCare } from "./rispostaCustomerCare";
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
  /** Id della recensione su Google (dall'email Zapier), se presente. */
  idGoogle: string;
  numeroMessaggi: number;
  haRisposta: boolean;
  risolto: boolean;
  /**
   * La risposta del customer care trovata NEL THREAD di questa recensione:
   * Cherubina ha già scritto il testo da pubblicare. Si legge qui, dalle email
   * che l'ingest ha in mano, e non costa nulla in più.
   *
   * Serve a riconoscere i ritorni di un inoltro fatto A MANO, fuori dal
   * portale: lì non esiste nessuna voce «in attesa» da aggiornare, e senza
   * questo segnale la recensione sembra semplicemente non gestita.
   */
  rispostaCustomerCare: { testo: string; ticket: number | null; quando: string } | null;
};

/** Il testo da mostrare e su cui ragionare: italiano se c'è, altrimenti l'originale. */
export function testoRecensione(r: Recensione): string {
  return (r.italiano ?? r.originale).trim();
}

export function haTesto(r: Recensione): boolean {
  return testoRecensione(r).length > 0;
}

/**
 * Nel gruppo c'è una risposta VERA del customer care? (non «Ticket Creato» né
 * «Ticket Risolto», che sono notifiche automatiche di Freshdesk).
 *
 * Si guarda dalla più recente e si prende la prima da cui `estraiRisposta`
 * riesce a isolare un testo: è quello che Cherubina ha scritto per il cliente.
 * Il corpo delle email è già in memoria — l'ingest lo carica comunque per
 * leggere la recensione — quindi qui non si paga nessuna chiamata in più.
 */
function rispostaNelGruppo(
  gruppo: MailDetail[],
): { testo: string; ticket: number | null; quando: string } | null {
  for (const m of [...gruppo].sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : -1))) {
    if (!m.fromAddress.toLowerCase().includes("customer.care")) continue;
    if (eNotifica(m.subject)) continue;
    const est = estraiRisposta(m.bodyIsHtml ? htmlToText(m.bodyContent) : m.bodyContent);
    if (est) return { ...est, quando: m.receivedDateTime };
  }
  return null;
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
    idGoogle: string;
    numeroMessaggi: number;
    haRisposta: boolean;
    risolto: boolean;
    rispostaCustomerCare: { testo: string; ticket: number | null; quando: string } | null;
  }[] = [];

  for (const [chiave, gruppo] of perConversazione) {
    // Il messaggio che contiene davvero i campi della recensione; si preferisce
    // l'originale di Zapier rispetto alle risposte che lo citano.
    let best: { msg: MailDetail; parsed: NonNullable<ReturnType<typeof parseReview>> } | null =
      null;
    // Zapier a volte manda la stessa recensione due volte. Fra i duplicati si
    // tiene il PIÙ VECCHIO: è quello l'istante in cui la recensione è arrivata
    // davvero, ed è rispetto a quello che nasce il ticket. Tenendo il più
    // recente, il ticket vero risultava anteriore alla recensione e non veniva
    // più agganciato.
    for (const m of gruppo) {
      const parsed = parseReview(m.bodyIsHtml ? htmlToText(m.bodyContent) : m.bodyContent);
      if (!parsed) continue;

      if (!best) {
        best = { msg: m, parsed };
        continue;
      }

      const questoZapier = m.fromAddress.toLowerCase().includes("zapier");
      const bestZapier = best.msg.fromAddress.toLowerCase().includes("zapier");

      // Un messaggio di Zapier batte sempre una risposta che lo cita.
      if (questoZapier && !bestZapier) {
        best = { msg: m, parsed };
        continue;
      }
      // A parità di provenienza vince il più vecchio.
      if (questoZapier === bestZapier && m.receivedDateTime < best.msg.receivedDateTime) {
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
      idGoogle: best.parsed.idGoogle,
      numeroMessaggi: gruppo.length,
      risolto: gruppo.some((m) => /ticket\s+risolto/i.test(m.subject)),
      haRisposta: gruppo.some((m) => {
        const a = m.fromAddress.toLowerCase();
        return (
          a.endsWith("@galdierirent.it") && !a.startsWith("customer.care") && !a.includes("zapier")
        );
      }),
      rispostaCustomerCare: rispostaNelGruppo(gruppo),
    });
  }

  return grezze.sort(
    (a, b) =>
      new Date(b.msg.receivedDateTime).getTime() - new Date(a.msg.receivedDateTime).getTime(),
  );
}

// Cache in memoria dell'ULTIMO caricamento (per label + finestra). Il carico è
// pesante — legge fino a `top` email da Graph col corpo (100 dalla home, 200 di
// default per le automazioni), traduce e salva su Mongo — e la home si ricarica
// di continuo: ogni click, ogni ritorno sulla scheda, l'auto-refresh ogni 3 min.
// Senza cache ripagava tutto ogni volta. TTL breve: i dati possono avere fino a
// ~90s, accettabile per una coda. Solo il tasto «Aggiorna» (fresh=1) passa
// `forza: true` e ricarica davvero; l'auto-refresh (AutoAggiorna.tsx) è morbido
// e cavalca la cache. Vive nel processo del server: si azzera solo a un riavvio.
type CaricoRecensioni = { recensioni: Recensione[]; analizzate: number };
const cacheCarico = new Map<string, { at: number; dati: CaricoRecensioni }>();
const TTL_CARICO_MS = 90_000;

export async function caricaRecensioni(
  label: Label,
  opts: { top?: number; forza?: boolean } = {},
): Promise<{ recensioni: Recensione[]; analizzate: number }> {
  const top = opts.top ?? 200;
  const chiaveCache = `${label.id}#${top}`;
  if (!opts.forza) {
    const hit = cacheCarico.get(chiaveCache);
    if (hit && Date.now() - hit.at < TTL_CARICO_MS) return hit.dati;
  }

  const messaggi = await searchMessages({
    subjectContains: label.subjectContains,
    fromContains: label.fromContains,
    // Finestra della posta: le 200 email-recensione più recenti (il massimo che
    // searchMessages carica). A 50 le recensioni non risposte "vecchie" — quelle
    // scivolate sotto le più nuove — sparivano dalla coda pur non essendo state
    // gestite (es. Arthur, #96). Serve anche alle azioni Play/Rispondi/G, che
    // ritrovano la recensione per chiave rileggendo la stessa finestra.
    top,
    mailbox: await activeMailbox(),
  });

  const grezze = raggruppa(messaggi, label);

  // Google allega spesso anche la propria traduzione inglese: si tiene da parte
  // il testo del cliente e si traduce quello.
  const parti = grezze.map((g) => splitTranslation(g.commento));
  const originali = parti.map((p) => p.original || p.translated);
  const traduzioni = await translateToItalian(originali);

  // Quante conversazioni non contenevano una recensione interpretabile: senza
  // questo numero non si può dire quanto è coperta la raccolta, e ogni
  // statistica sui tempi diventa indifendibile.
  const interpretati = grezze.length;

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
    idGoogle: g.idGoogle,
    numeroMessaggi: g.numeroMessaggi,
    haRisposta: g.haRisposta,
    risolto: g.risolto,
    rispostaCustomerCare: g.rispostaCustomerCare,
  }));

  // Archiviazione: da qui in poi la recensione esiste anche quando uscirà
  // dalle ultime 50 email. È fuori dal percorso critico — se fallisce, lo
  // dice in console e le pagine funzionano lo stesso.
  // Gli scarti si contano sulla stessa unità degli interpretati, cioè le
  // CONVERSAZIONI: sottrarre le conversazioni dalle email darebbe come
  // "non interpretabile" ogni risposta dentro un flusso già riconosciuto.
  const conversazioni = new Set(messaggi.map((m) => m.conversationId || m.id)).size;
  await salvaRecensioni(recensioni, label.id, {
    letti: messaggi.length,
    interpretati,
    scartati: Math.max(0, conversazioni - interpretati),
  });

  // Ritorni del customer care su inoltri fatti A MANO: si registrano qui,
  // subito dopo l'archiviazione, perché è qui che i thread completi ci sono
  // ancora. Fuori dal percorso critico, come l'archiviazione: se fallisce lo
  // dice in console e la pagina si carica lo stesso.
  try {
    const n = await registraRitorniCustomerCare(recensioni);
    if (n > 0) console.log(`[ritorni] risposte del customer care riconosciute e precompilate: ${n}.`);
  } catch (e) {
    console.warn("[ritorni] registrazione saltata:", e instanceof Error ? e.message : e);
  }

  const dati = { recensioni, analizzate: messaggi.length };
  cacheCarico.set(chiaveCache, { at: Date.now(), dati });
  return dati;
}
