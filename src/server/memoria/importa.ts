import { forEachMessageInFolder, getConversation } from "@/server/graph/client";
import {
  htmlToText,
  locationFromSubject,
  parseReview,
  splitTranslation,
} from "@/server/reviews/parse";
import { leggiRecensione } from "@/server/db/recensioni";
import {
  upsertEsempi,
  type EsempioDaImportare,
  type LinguaEsempio,
  type TipoEsempio,
} from "@/server/db/memoria";
import { activeMailbox, loadSettings } from "@/server/settings";

// ---------------------------------------------------------------------------
// Importazione della MEMORIA dalla Posta inviata di Stefania.
//
// Si scorre la cartella «Posta inviata» degli ultimi N mesi (streaming, pagina
// per pagina) e si tengono SOLO le risposte «R:» alle notifiche di recensione.
// Di ognuna:
//   - il testo scritto da Stefania: è la parte sopra la citazione. Si taglia al
//     primo marcatore di citazione/firma (Outlook, Gmail, la riga «Nome:» con
//     cui inizia la recensione citata di Zapier, la firma, il footer);
//   - la recensione a cui rispondeva: la notifica di Zapier è CITATA sotto, e
//     parseReview la legge da lì (stesso parser della posta in arrivo). Se non
//     c'è, si prova l'archivio per conversazione; altrimenti «senza-recensione».
// Gli inoltri «I:» a Cherubina («Si trasmette per quanto di competenza») non
// sono risposte e si saltano.
//
// Negative/neutre: nel flusso reale il testo lo scrive Cherubina e Stefania lo
// rimanda. Si guarda la conversazione: se c'è un messaggio del customer care
// PRIMA della risposta di Stefania, il testo è di Cherubina → origine
// «customer-care», e nasce già escluso dal contesto.
// ---------------------------------------------------------------------------

/** Marcatori che segnano la FINE del testo di Stefania (citazione, firma, footer). */
const FINE_TESTO: RegExp[] = [
  /\n\s*_{5,}/, // separatore Outlook
  /\n\s*-{3,}\s*(messaggio originale|original message)/i,
  // Intestazione citata («Da: … Inviato: …» / «From: … Sent: …»). SENZA
  // pretendere un a-capo prima: Outlook in inglese la incolla sulla stessa
  // riga del testo («Grazie. From: no-reply…zapiermail… Sent: …»).
  /\b(da|from)\s*:\s+[\s\S]{0,400}?\b(inviato|sent)\s*:/i,
  /\n\s*il\s+\S+[,.]?\s+\d[^\n]*\bha\s+scritto\s*:/i, // "Il gio 3 set 2026 … ha scritto:"
  /\n\s*on\s+[^\n]*\bwrote\s*:/i,
  /\n\s*nome\s*:\s/i, // inizio della recensione citata (Zapier)
  /\n\s*stefania\s+maffeo\b/i, // firma
  /www\.galdierirent\.it/i,
  /\bground\s+s\.?\s?r\.?\s?l\./i,
  /visit this link/i,
];

/** Isola il testo scritto da Stefania dal corpo (già testo) dell'email inviata. */
export function estraiTestoRisposta(corpoTesto: string): string {
  const t = (corpoTesto || "").replace(/\r/g, "");
  let fine = t.length;
  for (const re of FINE_TESTO) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index < fine) fine = m.index;
  }
  return t
    .slice(0, fine)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lingua della RISPOSTA (non della recensione): quella in cui scrive Stefania. */
export function linguaDelTesto(testo: string): LinguaEsempio {
  const t = ` ${testo.toLowerCase().replace(/\s+/g, " ")} `;
  const conta = (parole: string[]) => parole.reduce((n, p) => n + (t.includes(` ${p}`) ? 1 : 0), 0);
  const en = conta([
    "dear",
    "thank",
    "thanks",
    "we ",
    "we'",
    "your",
    "you ",
    "sorry",
    "regards",
    "feedback",
    "forward",
    "hope",
    "apolog",
    "kind",
    "best",
    "pleased",
    "glad",
  ]);
  const it = conta([
    "gentile",
    "grazie",
    "ringraziamo",
    "ringrazio",
    "siamo",
    "suo ",
    "sua ",
    "lei ",
    "cordiali",
    "saluti",
    "spiacenti",
    "dispiace",
    "presto",
    "buongiorno",
    "buonasera",
    "recensione",
    "felici",
  ]);
  if (en === 0 && it === 0) return "altro";
  return en > it ? "en" : "it";
}

export function tipoPer(stelle: number | null, commento: string): TipoEsempio {
  if (stelle === null) return "senza-recensione";
  if (stelle <= 2) return "negativa";
  if (stelle === 3) return "neutra";
  return commento.trim() ? "positiva-con-testo" : "positiva-senza-testo";
}

const eRisposta = (subject: string) => /^\s*(r|re)\s*:/i.test(subject);
const eInoltro = (subject: string) => /^\s*(i|fw|fwd)\s*:/i.test(subject);
const eNotifica = (subject: string) => /^\s*ticket\s+(creato|risolto|chiuso)/i.test(subject);

/** Il testo dell'INOLTRO a Cherubina, a volte spedito come «R:»: non è una risposta. */
const eTestoInoltro = (testo: string) => /^\s*si trasmette per quanto di competenza/i.test(testo);

/**
 * Le formule con cui apre il customer care («abbiamo letto con attenzione il
 * suo commento…»). Se il testo comincia così è di Cherubina anche quando la sua
 * mail non sta nella stessa conversazione (o Stefania l'ha copiato a mano).
 */
const TEMPLATE_CUSTOMER_CARE: RegExp[] = [
  /abbiamo letto con attenzione il suo commento/i,
  /we have (carefully )?read your (comment|review)( carefully)?/i,
  /abbiamo letto attentamente/i,
];
export const sembraTestoCustomerCare = (testo: string) =>
  TEMPLATE_CUSTOMER_CARE.some((re) => re.test(testo));

/** C'è un messaggio del customer care/Cherubina in conversazione PRIMA di `prima`? */
async function rispostaCustomerCarePrima(
  conversationId: string,
  prima: Date,
  mailbox: string,
): Promise<boolean> {
  if (!conversationId) return false;
  try {
    const messaggi = await getConversation(conversationId, mailbox);
    return messaggi.some((m) => {
      const a = m.fromAddress.toLowerCase();
      return (
        (a.includes("customer.care") || a.includes("cherubina")) &&
        !eNotifica(m.subject) &&
        new Date(m.receivedDateTime).getTime() < prima.getTime()
      );
    });
  } catch {
    return false;
  }
}

export type EsitoImport = {
  mesi: number;
  dal: string;
  pagine: number;
  emailLette: number;
  emailRecensione: number;
  inoltriSaltati: number;
  altriSaltati: number;
  senzaTesto: number;
  dallaCitazione: number;
  dallArchivio: number;
  senzaRecensione: number;
  controllateCustomerCare: number;
  daCustomerCare: number;
  nuove: number;
  aggiornate: number;
  perTipo: Record<TipoEsempio, number>;
  perLingua: Record<LinguaEsempio, number>;
  campioni: {
    tipo: TipoEsempio;
    lingua: LinguaEsempio;
    stelle: number | null;
    nome: string;
    commento: string;
    risposta: string;
  }[];
};

/**
 * Importa (o riallinea) la memoria dagli ultimi `mesi` mesi di Posta inviata.
 * Idempotente: le voci già presenti si riallineano senza toccare attivo/eliminata.
 */
export async function importaMemoria(
  mesi = 12,
  log: (riga: string) => void = () => {},
): Promise<EsitoImport> {
  const settings = await loadSettings();
  const label = settings.labels[0];
  if (!label?.subjectContains) throw new Error("Nessuna etichetta recensioni configurata.");
  const mailbox = await activeMailbox();
  const dal = new Date(Date.now() - mesi * 30 * 24 * 60 * 60 * 1000);

  const voci: EsempioDaImportare[] = [];
  const stat = {
    inoltriSaltati: 0,
    altriSaltati: 0,
    senzaTesto: 0,
    dallaCitazione: 0,
    dallArchivio: 0,
    senzaRecensione: 0,
  };

  log(
    `Scorro la Posta inviata dal ${dal.toISOString().slice(0, 10)} (oggetto «${label.subjectContains}»)…`,
  );
  const scan = await forEachMessageInFolder(
    {
      folder: "SentItems",
      since: dal,
      subjectContains: label.subjectContains,
      mailbox,
      onPage: (i) =>
        log(
          `  pagina ${i.pagina}: lette ${i.letti}, sulle recensioni ${i.tenuti} · fino al ${i.ultimaData.slice(0, 10)}`,
        ),
    },
    async (m) => {
      if (eInoltro(m.subject)) {
        stat.inoltriSaltati++;
        return;
      }
      if (!eRisposta(m.subject)) {
        stat.altriSaltati++;
        return;
      }
      const corpo = m.bodyIsHtml ? htmlToText(m.bodyContent) : m.bodyContent;
      const risposta = estraiTestoRisposta(corpo);
      if (!risposta || /^(da|from)\s*:/i.test(risposta)) {
        stat.senzaTesto++;
        return;
      }
      if (eTestoInoltro(risposta)) {
        stat.inoltriSaltati++;
        return;
      }

      // La recensione: dalla citazione di Zapier, altrimenti dall'archivio.
      let stelle: number | null = null;
      let nome = "";
      let commento = "";
      const parsed = parseReview(corpo);
      if (parsed) {
        stat.dallaCitazione++;
        stelle = parsed.score;
        nome = parsed.name;
        const p = splitTranslation(parsed.comment);
        commento = (p.original || p.translated).trim();
      } else {
        const arch = await leggiRecensione(m.conversationId);
        if (arch) {
          stat.dallArchivio++;
          stelle = arch.stelle;
          nome = arch.nome;
          commento = (arch.originale || "").trim();
        } else {
          stat.senzaRecensione++;
        }
      }

      const tipo = tipoPer(stelle, commento);
      voci.push({
        chiave: m.id,
        conversationId: m.conversationId,
        tipo,
        stelle,
        lingua: linguaDelTesto(risposta),
        sedeNome: locationFromSubject(m.subject, label.subjectContains),
        nomeCliente: nome,
        commento,
        risposta,
        inviataIl: new Date(m.receivedDateTime),
        origine: "stefania",
        attivoIniziale: tipo !== "senza-recensione",
      });
    },
  );

  // Testo del customer care riconoscibile dalla formula d'apertura: vale per
  // qualunque tipo, anche fuori conversazione.
  let daCustomerCare = 0;
  for (const v of voci) {
    if (sembraTestoCustomerCare(v.risposta)) {
      v.origine = "customer-care";
      v.attivoIniziale = false;
      daCustomerCare++;
    }
  }

  // Negative/neutre: il testo potrebbe essere di Cherubina, rimandato da Stefania.
  const daControllare = voci.filter(
    (v) => v.origine === "stefania" && (v.tipo === "negativa" || v.tipo === "neutra"),
  );
  log(
    `Controllo ${daControllare.length} negative/neutre: risposta di Stefania o del customer care?`,
  );
  for (const v of daControllare) {
    if (await rispostaCustomerCarePrima(v.conversationId, v.inviataIl, mailbox)) {
      v.origine = "customer-care";
      v.attivoIniziale = false;
      daCustomerCare++;
    }
  }

  log(`Salvo ${voci.length} voci…`);
  const { nuove, aggiornate } = await upsertEsempi(voci);

  const perTipo = {
    "positiva-con-testo": 0,
    "positiva-senza-testo": 0,
    neutra: 0,
    negativa: 0,
    "senza-recensione": 0,
  } as Record<TipoEsempio, number>;
  const perLingua = { it: 0, en: 0, altro: 0 } as Record<LinguaEsempio, number>;
  const campioni: EsitoImport["campioni"] = [];
  const visti = new Set<string>();
  for (const v of voci) {
    perTipo[v.tipo]++;
    perLingua[v.lingua]++;
    const k = `${v.tipo}|${v.lingua}|${v.origine}`;
    if (!visti.has(k)) {
      visti.add(k);
      campioni.push({
        tipo: v.tipo,
        lingua: v.lingua,
        stelle: v.stelle,
        nome: v.nomeCliente,
        commento: v.commento,
        risposta: v.origine === "customer-care" ? `[customer care] ${v.risposta}` : v.risposta,
      });
    }
  }

  return {
    mesi,
    dal: dal.toISOString(),
    pagine: scan.pagine,
    emailLette: scan.letti,
    emailRecensione: scan.tenuti,
    ...stat,
    controllateCustomerCare: daControllare.length,
    daCustomerCare,
    nuove,
    aggiornate,
    perTipo,
    perLingua,
    campioni,
  };
}
