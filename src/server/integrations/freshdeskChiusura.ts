import { agenteApiId, conRetry429, getTicket } from "./freshdesk";
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

/** Etichetta stelle come la vuole il dropdown: «1 stella» (sing.), «N stelle». */
function etichettaStelle(stelle: number): string {
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

/**
 * Chiude il ticket: stato Risolto, CLASSIFICAZIONE (tipo «Recensioni clienti
 * GMB», tag sede + «personale», campo annidato con le stelle), nota privata.
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
      descrizione: `Chiuderebbe il ticket #${ticketId} (Risolto, tipo «${cls.type}»${dettStelle}${opts.tagSede ? `, tag «${opts.tagSede}»+«personale»` : ""}) e vi aggiungerebbe la nota privata.`,
      chiamate: [
        `PUT ${urlTicket} { status: 4, type, tags, custom_fields }`,
        `POST ${urlTicket}/notes { private: true, body: "${opts.nota.slice(0, 60)}…" }`,
      ],
    };
  }

  try {
    // forza=true: una scrittura deve partire dallo stato FRESCO del ticket (tag
    // e agente correnti). Dalla cache si rischia di ripristinare tag ormai
    // cambiati (Freshdesk sostituisce l'intero array) o riassegnare il responder.
    const ticket = await getTicket(ticketId, true);
    const corpo = await corpoConClassificazione(ticket, opts.tagSede, opts.stelle, 4);

    const put = await fdScrittura(urlTicket, "PUT", corpo);
    if (!put.ok) return { stato: "fallita", errore: `PUT ${put.stato}: ${put.testo}` };

    const nota = await fdScrittura(`${urlTicket}/notes`, "POST", {
      body: opts.nota,
      private: true,
    });
    if (!nota.ok) return { stato: "fallita", errore: `nota ${nota.stato}: ${nota.testo}` };

    return { stato: "eseguita", descrizione: `Ticket #${ticketId} risolto, classificato e annotato.` };
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
