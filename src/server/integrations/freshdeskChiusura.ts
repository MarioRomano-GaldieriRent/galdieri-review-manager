import { getTicket } from "./freshdesk";
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
// Sui TAG: lo spec elenca "città, fonte, positiva/negativa, stelle, personale,
// ufficio". Nei ticket reali però la fonte è il TIPO del ticket, non un tag, e
// positiva/stelle stanno nel campo TipoRichiesta-UCM: come tag esistono solo la
// sede e "personale", messi alla creazione del ticket dall'automazione. Qui non
// si inventano tag nuovi — si assicura solo che il tag della sede ci sia, senza
// toccare gli altri. Meglio non taggare che sporcare il ticket.

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
  const res = await fetch(`https://${pulisciDominio(cfg.domain)}/api/v2${path}`, {
    method: metodo,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
    cache: "no-store",
  });
  return { ok: res.ok, stato: res.status, testo: res.ok ? "" : (await res.text()).slice(0, 200) };
}

/**
 * Chiude il ticket: stato Risolto, tag della sede (se manca), nota privata.
 *
 * Non solleva mai: restituisce un esito. Il chiamante decide se accodare a
 * retry (fallita) o proseguire (eseguita/simulata). Così l'operatore non si
 * blocca mai per un errore Freshdesk.
 */
export async function chiudiTicketPubblicato(
  ticketId: number,
  opts: { tagSede: string; nota: string },
): Promise<EsitoChiusura> {
  const urlTicket = `/tickets/${ticketId}`;

  if (!(await scritturaConsentita())) {
    return {
      stato: "simulata",
      descrizione: `Chiuderebbe il ticket #${ticketId} (stato Risolto${opts.tagSede ? `, tag «${opts.tagSede}»` : ""}) e vi aggiungerebbe la nota privata.`,
      chiamate: [
        `PUT ${urlTicket} { status: 4, tags: [… + ${opts.tagSede || "nessun tag"}] }`,
        `POST ${urlTicket}/notes { private: true, body: "${opts.nota.slice(0, 60)}…" }`,
      ],
    };
  }

  try {
    // I tag si fondono con quelli esistenti: Freshdesk sostituisce l'intero
    // array, quindi va riletto e rimandato completo.
    const ticket = await getTicket(ticketId);
    const tags = [...ticket.tags];
    if (opts.tagSede && !tags.includes(opts.tagSede)) tags.push(opts.tagSede);

    const put = await fdScrittura(urlTicket, "PUT", { status: 4, tags });
    if (!put.ok) return { stato: "fallita", errore: `PUT ${put.stato}: ${put.testo}` };

    const nota = await fdScrittura(`${urlTicket}/notes`, "POST", {
      body: opts.nota,
      private: true,
    });
    if (!nota.ok) return { stato: "fallita", errore: `nota ${nota.stato}: ${nota.testo}` };

    return { stato: "eseguita", descrizione: `Ticket #${ticketId} risolto e annotato.` };
  } catch (e) {
    return { stato: "fallita", errore: e instanceof Error ? e.message : "errore sconosciuto" };
  }
}
