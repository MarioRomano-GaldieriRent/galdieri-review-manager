import { agenteApiId, conRetry429, elencoTicketRecenti, getTicket, STATO, type FdTicket } from "./freshdesk";
import { resolveFreshdesk, scritturaConsentita } from "@/server/settings";

// Chiusura del ticket quando la risposta è stata pubblicata a mano su Google.
//
// SCRITTURA. A differenza di freshdesk.ts (sola lettura), qui ci sono due
// chiamate che modificano il ticket:
//   PUT  /tickets/{id}   stato Risolto + tag della sede
//   POST /tickets/{id}/notes   nota privata "Risposta pubblicata a mano da…"
//
// Entrambe passano dal controllo scritturaConsentita(): in simulazione non
// parte nulla e si restituisce solo la descrizione. È lo stesso presidio dei
// nodi delle automazioni.
//
// Sui campi: la fonte è il TIPO del ticket ("Recensioni clienti GMB"), e
// positiva/stelle stanno nel campo annidato TipoRichiesta-UCM; come tag ci sono
// la sede e "personale". L'automazione di solito li mette alla CREAZIONE, ma
// alcuni ticket arrivano senza: perciò la chiusura li REIMPOSTA (campiClassificazione),
// così il ticket resta come tutti gli altri. Valori presi dai dropdown reali.

export type EsitoChiusura =
  | { stato: "eseguita"; descrizione: string }
  | { stato: "simulata"; descrizione: string; chiamate: string[] }
  | { stato: "fallita"; errore: string };

/** Testo della nota privata lasciata sul ticket. */
export function testoNotaPubblicazione(operatore: string, quando: Date, risposta: string): string {
  const data = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" }).format(
    quando,
  );
  return `Risposta pubblicata manualmente da ${operatore} il ${data}.\n\nTesto: ${risposta}`;
}

function pulisciDominio(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function fdScrittura(
  path: string,
  metodo: "PUT" | "POST",
  corpo: unknown,
): Promise<{ ok: boolean; stato: number; testo: string }> {
  const cfg = await resolveFreshdesk();
  if (!cfg.domain || !cfg.apiKey) throw new Error("Freshdesk non configurato.");
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;
  const url = `https://${pulisciDominio(cfg.domain)}/api/v2${path}`;
  // conRetry429: un 429 breve non deve far fallire la chiusura del ticket.
  const res = await conRetry429(() =>
    fetch(url, {
      method: metodo,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      cache: "no-store",
    }),
  );
  return { ok: res.ok, stato: res.status, testo: res.ok ? "" : (await res.text()).slice(0, 200) };
}

// --- Classificazione del ticket-recensione Google -------------------------
//
// I ticket delle recensioni vanno marcati come tutti gli altri: TIPO «Recensioni
// clienti GMB», tag «personale», e il campo annidato TipoRichiesta-UCM
//   «gestione recensioni clienti» → positiva/negativa → «N stelle».
// L'automazione di solito li mette alla creazione, ma alcuni ticket arrivano
// SENZA (es. creati in ritardo): la chiusura li reimposta, così restano
// uniformi. I valori sono quelli ESATTI dei dropdown Freshdesk (un valore fuori
// elenco dà 400): «1 stella» è singolare, «2..5 stelle» plurale.

const TIPO_RECENSIONE_GMB = "Recensioni clienti GMB";

/**
 * Etichetta stelle come la vuole il dropdown: «1 stella» (sing.), «N stelle».
 * Esportata perché la usa anche il nodo «Classifica il ticket» dei flussi: le
 * due strade devono scrivere lo stesso valore, o una delle due prende il 400.
 */
export function etichettaStelle(stelle: number): string {
  return stelle === 1 ? "1 stella" : `${stelle} stelle`;
}

/**
 * I campi con cui marcare il ticket: tipo, tag «personale» e il campo annidato
 * (positiva se ≥4 stelle, altrimenti negativa; sotto-livello «N stelle»). Con le
 * stelle assenti si mette solo il primo livello del campo annidato.
 */
function campiClassificazione(stelle: number | null): {
  type: string;
  tag: string;
  custom_fields: Record<string, string>;
} {
  const cf: Record<string, string> = { cf_tipo_di_richiesta: "gestione recensioni clienti" };
  if (typeof stelle === "number" && stelle >= 1 && stelle <= 5) {
    cf.cf_specifica_1 = stelle >= 4 ? "positiva" : "negativa";
    cf.cf_specifica_2 = etichettaStelle(stelle);
  }
  return { type: TIPO_RECENSIONE_GMB, tag: "personale", custom_fields: cf };
}

/**
 * Corpo del PUT con tipo + tag (uniti a quelli esistenti: Freshdesk sostituisce
 * l'intero array) + campi annidati. Se `status` è dato lo imposta, e in quel
 * caso — se il ticket non ha un agente — assegna il responder (Freshdesk non
 * risolve un ticket non assegnato: dà 400 su responder_id).
 */
async function corpoConClassificazione(
  ticket: Awaited<ReturnType<typeof getTicket>>,
  tagSede: string,
  stelle: number | null,
  status?: number,
): Promise<Record<string, unknown>> {
  const cls = campiClassificazione(stelle);
  const tags = [...ticket.tags];
  for (const t of [tagSede, cls.tag]) if (t && !tags.includes(t)) tags.push(t);
  const corpo: Record<string, unknown> = { type: cls.type, tags, custom_fields: cls.custom_fields };
  if (status != null) {
    corpo.status = status;
    if (ticket.responderId == null) {
      const agente = await agenteApiId();
      if (agente) corpo.responder_id = agente;
    }
  }
  return corpo;
}

// --- I ticket GEMELLI -----------------------------------------------------
//
// Freshdesk a volte crea DUE ticket dalla stessa email: stesso oggetto, stesso
// richiedente, stesso secondo, e come unica differenza la formattazione del
// corpo. Il portale ne lavora uno e chiude quello; il gemello resta aperto per
// sempre, senza tipo e senza campi, e finisce nella coda del customer care.
//
// Segnalati da Cherubina il 30/10/2026: #62737, #62766 e #63054, gemelli di
// #62738, #62767 e #63055 — tre ticket «risposti ma non chiusi». Sugli ultimi
// 600 ticket le coppie nate nello stesso minuto sono 53, e in 5 casi uno era
// chiuso e l'altro no.
//
// Il gemello si CHIUDE ma non si classifica: la recensione è una sola e
// contarla due volte falserebbe i rapporti di Freshdesk. Prende il tag
// «caso_sdoppiato», che è già la convenzione con cui il customer care segna i
// doppioni, e una nota privata che rimanda al ticket vero.

/** Il tag con cui il customer care marca i doppioni: si riusa quello. */
const TAG_DOPPIONE = "caso_sdoppiato";

/**
 * Quanto vicini devono essere due ticket per essere lo stesso messaggio.
 *
 * Stretto di proposito: l'oggetto delle recensioni è identico per tutte quelle
 * della stessa sede («RE: NUOVA RECENSIONE GOOGLE <sede>»), quindi da solo non
 * prova niente. I gemelli veri misurati distano 0-1 secondi, mentre due
 * recensioni diverse della stessa sede non possono nascere a dieci secondi
 * l'una dall'altra: ogni pubblicazione dura minuti.
 */
const GEMELLI_ENTRO_MS = 10_000;

/** Al massimo tanti gemelli per ticket: oltre, qualcosa non torna e meglio fermarsi. */
const MAX_GEMELLI = 3;

/**
 * I gemelli ancora aperti di un ticket: stesso oggetto, nati nello stesso
 * istante, mai classificati (il tipo è vuoto) e non ancora chiusi.
 *
 * Legge l'elenco dei ticket recenti, che è in cache e di solito non costa
 * nessuna chiamata. Se il ticket è più vecchio della finestra, non si trova
 * niente: pazienza, non è un errore.
 */
async function gemelliAperti(ticket: FdTicket): Promise<FdTicket[]> {
  const recenti = await elencoTicketRecenti(6).catch(() => [] as FdTicket[]);
  const quando = new Date(ticket.createdAt).getTime();
  const oggetto = ticket.subject.trim().toLowerCase();
  if (!oggetto || !Number.isFinite(quando)) return [];
  return recenti
    .filter(
      (t) =>
        t.id !== ticket.id &&
        (t.status === 2 || t.status === 3) &&
        !t.type &&
        t.subject.trim().toLowerCase() === oggetto &&
        Math.abs(new Date(t.createdAt).getTime() - quando) <= GEMELLI_ENTRO_MS,
    )
    .slice(0, MAX_GEMELLI);
}

/** Chiude un gemello: stato Risolto, tag del doppione, nota che rimanda all'originale. */
async function chiudiDoppione(gemello: FdTicket, originale: number): Promise<string> {
  const ticket = await getTicket(gemello.id, true);
  if (ticket.status === 4 || ticket.status === 5) return "";

  const tags = [...ticket.tags];
  if (!tags.includes(TAG_DOPPIONE)) tags.push(TAG_DOPPIONE);
  const corpo: Record<string, unknown> = { status: 4, tags };
  // Freshdesk non risolve un ticket senza agente: dà 400 su responder_id.
  if (ticket.responderId == null) {
    const agente = await agenteApiId();
    if (agente) corpo.responder_id = agente;
  }

  const put = await fdScrittura(`/tickets/${gemello.id}`, "PUT", corpo);
  if (!put.ok) return `#${gemello.id} NON chiuso (PUT ${put.stato})`;
  await fdScrittura(`/tickets/${gemello.id}/notes`, "POST", {
    body: `Doppione del ticket #${originale}: la stessa email ne ha creati due. Chiuso dal portale recensioni, la lavorazione è sul #${originale}.`,
    private: true,
  });
  return `#${gemello.id} chiuso come doppione`;
}

/**
 * Chiude dei doppioni già individuati altrove (lo script di recupero
 * scripts/chiudi-doppioni.ts, per quelli accumulati prima di questa modifica).
 * Rispetta la modalità simulazione come tutto il resto del file.
 */
export async function chiudiDoppioniRimasti(
  coppie: { gemelloId: number; originaleId: number }[],
): Promise<string[]> {
  if (!(await scritturaConsentita())) {
    return coppie.map(
      (c) => `#${c.gemelloId}: in simulazione non si scrive (sarebbe chiuso come doppione di #${c.originaleId}).`,
    );
  }
  const esiti: string[] = [];
  for (const c of coppie) {
    const ticket = await getTicket(c.gemelloId, true).catch(() => null);
    if (!ticket) {
      esiti.push(`#${c.gemelloId}: non leggibile da Freshdesk.`);
      continue;
    }
    esiti.push(
      (await chiudiDoppione(ticket, c.originaleId).catch(
        (e) => `#${c.gemelloId} NON chiuso (${e instanceof Error ? e.message : "errore"})`,
      )) || `#${c.gemelloId}: era già chiuso, lasciato com'era.`,
    );
  }
  return esiti;
}

/** Chiude i gemelli aperti. Non solleva mai: un doppione non deve far fallire la chiusura vera. */
async function chiudiGemelliDi(ticket: FdTicket): Promise<string[]> {
  try {
    const gemelli = await gemelliAperti(ticket);
    const esiti: string[] = [];
    for (const g of gemelli) {
      const esito = await chiudiDoppione(g, ticket.id).catch(
        (e) => `#${g.id} NON chiuso (${e instanceof Error ? e.message : "errore"})`,
      );
      if (esito) esiti.push(esito);
    }
    return esiti;
  } catch {
    return [];
  }
}

/**
 * Chiude il ticket: stato Risolto, CLASSIFICAZIONE (tipo «Recensioni clienti
 * GMB», tag sede + «personale», campo annidato con le stelle), nota privata.
 *
 * Chiude anche gli eventuali GEMELLI (vedi sopra): due ticket nati dalla stessa
 * email, di cui finora se ne chiudeva uno solo.
 *
 * Se il ticket è GIÀ Risolto o Chiuso non lo si ri-chiude: gli si mette solo la
 * classificazione che gli manca, senza toccare lo stato e senza aggiungere una
 * seconda nota. Rimetterlo a «Risolto» riporterebbe indietro un ticket che
 * qualcuno ha già portato a «Chiuso» a mano — ed è esattamente il caso che
 * capita ai recuperi, dove nel frattempo il ticket può essere stato lavorato.
 *
 * Non solleva mai: restituisce un esito. Il chiamante decide se accodare a
 * retry (fallita) o proseguire (eseguita/simulata). Così l'operatore non si
 * blocca mai per un errore Freshdesk.
 */
export async function chiudiTicketPubblicato(
  ticketId: number,
  opts: { tagSede: string; nota: string; stelle: number | null },
): Promise<EsitoChiusura> {
  const urlTicket = `/tickets/${ticketId}`;

  if (!(await scritturaConsentita())) {
    const cls = campiClassificazione(opts.stelle);
    const dettStelle = opts.stelle
      ? `, ${cls.custom_fields.cf_specifica_1 ?? ""} ${etichettaStelle(opts.stelle)}`
      : "";
    return {
      stato: "simulata",
      descrizione: `Chiuderebbe il ticket #${ticketId} (Risolto, tipo «${cls.type}»${dettStelle}${opts.tagSede ? `, tag «${opts.tagSede}»+«personale»` : ""}) e vi aggiungerebbe la nota privata. Chiuderebbe anche gli eventuali ticket gemelli, col tag «${TAG_DOPPIONE}».`,
      chiamate: [
        `PUT ${urlTicket} { status: 4, type, tags, custom_fields }`,
        `POST ${urlTicket}/notes { private: true, body: "${opts.nota.slice(0, 60)}…" }`,
        `PUT /tickets/{gemello} { status: 4, tags: [… "${TAG_DOPPIONE}"] } (solo se ci sono doppioni)`,
      ],
    };
  }

  try {
    // forza=true: una scrittura deve partire dallo stato FRESCO del ticket (tag
    // e agente correnti). Dalla cache si rischia di ripristinare tag ormai
    // cambiati (Freshdesk sostituisce l'intero array) o riassegnare il responder.
    const ticket = await getTicket(ticketId, true);

    // Già Risolto/Chiuso: solo la classificazione mancante, niente stato e
    // niente nota (sarebbe la seconda). Stessa regola dello script chiudi:ticket.
    const giaChiuso = ticket.status === 4 || ticket.status === 5;
    const corpo = await corpoConClassificazione(
      ticket,
      opts.tagSede,
      opts.stelle,
      giaChiuso ? undefined : 4,
    );

    const put = await fdScrittura(urlTicket, "PUT", corpo);
    if (!put.ok) return { stato: "fallita", errore: `PUT ${put.stato}: ${put.testo}` };

    if (giaChiuso) {
      const doppioni = await chiudiGemelliDi(ticket);
      return {
        stato: "eseguita",
        descrizione:
          `Ticket #${ticketId} era già ${STATO[ticket.status] ?? "chiuso"}: classificato, stato e note lasciati com'erano.` +
          (doppioni.length ? ` Doppioni: ${doppioni.join(", ")}.` : ""),
      };
    }

    const nota = await fdScrittura(`${urlTicket}/notes`, "POST", {
      body: opts.nota,
      private: true,
    });
    if (!nota.ok) return { stato: "fallita", errore: `nota ${nota.stato}: ${nota.testo}` };

    const doppioni = await chiudiGemelliDi(ticket);
    return {
      stato: "eseguita",
      descrizione:
        `Ticket #${ticketId} risolto, classificato e annotato.` +
        (doppioni.length ? ` Doppioni: ${doppioni.join(", ")}.` : ""),
    };
  } catch (e) {
    return { stato: "fallita", errore: e instanceof Error ? e.message : "errore sconosciuto" };
  }
}

/**
 * Rimette SOLO la classificazione (tipo, tag «personale», campo annidato con le
 * stelle) su un ticket che ha già la risposta ma è arrivato senza — SENZA
 * cambiare stato né aggiungere note. Serve a sistemare i ticket già chiusi ma
 * non classificati (es. Arthur, chiuso a mano prima di questa correzione).
 */
export async function applicaClassificazioneRecensione(
  ticketId: number,
  opts: { tagSede: string; stelle: number | null },
): Promise<EsitoChiusura> {
  const urlTicket = `/tickets/${ticketId}`;
  if (!(await scritturaConsentita())) {
    const cls = campiClassificazione(opts.stelle);
    return {
      stato: "simulata",
      descrizione: `Imposterebbe tipo «${cls.type}», tag «personale» e le stelle sul ticket #${ticketId} (senza toccare stato né note).`,
      chiamate: [`PUT ${urlTicket} { type, tags, custom_fields }`],
    };
  }
  try {
    // forza=true: una scrittura deve partire dallo stato FRESCO del ticket (tag
    // e agente correnti). Dalla cache si rischia di ripristinare tag ormai
    // cambiati (Freshdesk sostituisce l'intero array) o riassegnare il responder.
    const ticket = await getTicket(ticketId, true);
    const corpo = await corpoConClassificazione(ticket, opts.tagSede, opts.stelle);
    const put = await fdScrittura(urlTicket, "PUT", corpo);
    if (!put.ok) return { stato: "fallita", errore: `PUT ${put.stato}: ${put.testo}` };
    return { stato: "eseguita", descrizione: `Ticket #${ticketId} classificato.` };
  } catch (e) {
    return { stato: "fallita", errore: e instanceof Error ? e.message : "errore sconosciuto" };
  }
}
