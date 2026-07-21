import { forwardMessage } from "@/server/graph/client";
import { cercaTicketPerOggetto, STATO, type FdTicket } from "@/server/integrations/freshdesk";
import { rispondiARecensione } from "@/server/integrations/googleReviews";
import {
  activeMailbox,
  resolveFreshdesk,
  scritturaConsentita,
  type AutomationConfig,
} from "@/server/settings";
import type { Recensione } from "@/server/reviews/load";
import { testoRecensione } from "@/server/reviews/load";
import { citaIlPersonale, tagSede } from "./sedi";
import { CATALOGO, type Azione } from "./types";

// ---------------------------------------------------------------------------
// TUTTE le operazioni che modificano qualcosa fuori da questa applicazione
// passano da qui. Ogni funzione di scrittura comincia con lo stesso controllo:
// se la modalità operativa non è "reale" non parte nessuna chiamata e viene
// restituita soltanto la descrizione di cosa sarebbe successo.
// ---------------------------------------------------------------------------

export type Contesto = {
  recensione: Recensione;
  ticket: FdTicket | null;
  automation: AutomationConfig;
};

export type RisultatoNodo = {
  messaggio: string;
  chiamata: { metodo: string; url: string; corpo?: string } | null;
  /** true solo se la scrittura è avvenuta davvero. */
  eseguita: boolean;
  /** Il nodo non aveva nulla da fare. */
  saltato?: boolean;
  ticket?: FdTicket | null;
};

/** Sostituisce i segnaposto con i dati della recensione. */
export function interpola(testo: string, r: Recensione): string {
  const commento = testoRecensione(r);
  return testo
    .replace(/\{nome\}/g, r.nome || "cliente")
    .replace(/\{sede\}/g, tagSede(r.sede) || r.sede || "")
    .replace(/\{sedeEstesa\}/g, r.sede || "")
    .replace(/\{stelle\}/g, r.stelle ? String(r.stelle) : "")
    .replace(/\{commento\}/g, commento)
    .replace(/\{personale\}/g, citaIlPersonale(commento) ? "personale" : "")
    .trim();
}

// ------------------------------------------------------------------ lettura

async function trovaTicket(ctx: Contesto): Promise<RisultatoNodo> {
  // Questa è una GET: gira davvero anche in simulazione, ed è ciò che permette
  // di dire con precisione quale ticket sarebbe stato toccato.
  const t = await cercaTicketPerOggetto(ctx.recensione.oggetto, ctx.recensione.ricevutaIl);
  if (!t) {
    return {
      messaggio: `Nessun ticket trovato per «${ctx.recensione.oggetto}». I nodi successivi su Freshdesk verranno saltati.`,
      chiamata: null,
      eseguita: false,
      ticket: null,
    };
  }
  return {
    messaggio: `Ticket #${t.id} — stato «${STATO[t.status] ?? t.status}», tag [${t.tags.join(", ") || "nessuno"}]`,
    chiamata: null,
    eseguita: false,
    ticket: t,
  };
}

async function attendiRisposta(a: Azione, ctx: Contesto): Promise<RisultatoNodo> {
  const da = a.parametri.da || ctx.automation.emailEscalation;
  return {
    messaggio: `Il flusso si ferma qui in attesa della risposta di ${da}. Quando arriva riparte il flusso di ritorno: risposta su Google e chiusura del ticket.`,
    chiamata: null,
    eseguita: false,
  };
}

// ---------------------------------------------------------------- scrittura

/** Aggiornamento di un ticket Freshdesk. È l'unica PUT verso Freshdesk. */
async function aggiornaTicket(
  ctx: Contesto,
  campi: Record<string, unknown>,
  descrizione: string,
): Promise<RisultatoNodo> {
  if (!ctx.ticket) {
    return {
      messaggio: "Saltato: nessun ticket individuato dal nodo precedente.",
      chiamata: null,
      eseguita: false,
      saltato: true,
    };
  }

  const cfg = await resolveFreshdesk();
  const dominio = cfg.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const chiamata = {
    metodo: "PUT",
    url: `https://${dominio}/api/v2/tickets/${ctx.ticket.id}`,
    corpo: JSON.stringify(campi, null, 2),
  };

  if (!(await scritturaConsentita())) {
    return {
      messaggio: `${descrizione} sul ticket #${ctx.ticket.id} — non eseguito (modalità simulazione).`,
      chiamata,
      eseguita: false,
    };
  }

  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;
  const res = await fetch(chiamata.url, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(campi),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Freshdesk ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  return {
    messaggio: `${descrizione} sul ticket #${ctx.ticket.id} — eseguito.`,
    chiamata,
    eseguita: true,
  };
}

async function classifica(a: Azione, ctx: Contesto): Promise<RisultatoNodo> {
  const campi = {
    type: a.parametri.tipo || ctx.automation.tipoTicketGoogle,
    custom_fields: {
      cf_tipo_di_richiesta: "gestione recensioni clienti",
      cf_specifica_1: a.parametri.specifica1 || "",
      cf_specifica_2: a.parametri.specifica2 || "",
    },
  };
  return aggiornaTicket(
    ctx,
    campi,
    `Classificazione «${campi.type} / ${campi.custom_fields.cf_specifica_1} / ${campi.custom_fields.cf_specifica_2}»`,
  );
}

async function applicaTag(a: Azione, ctx: Contesto): Promise<RisultatoNodo> {
  const nuovi = interpola(a.parametri.tag ?? "", ctx.recensione)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (nuovi.length === 0) {
    return {
      messaggio: "Nessun tag da applicare (sede non riconosciuta e nessun tag tematico).",
      chiamata: null,
      eseguita: false,
      saltato: true,
    };
  }

  // I tag si aggiungono a quelli esistenti: Freshdesk sostituisce l'intero
  // elenco, quindi va rimandato completo.
  const esistenti = ctx.ticket?.tags ?? [];
  const uniti = [...new Set([...esistenti, ...nuovi])];
  return aggiornaTicket(ctx, { tags: uniti }, `Tag [${nuovi.join(", ")}]`);
}

async function assegna(a: Azione, ctx: Contesto): Promise<RisultatoNodo> {
  const id = Number(a.parametri.agenteId || ctx.automation.agenteMarketing);
  if (!Number.isFinite(id)) {
    return {
      messaggio: `Id agente non valido: «${a.parametri.agenteId}».`,
      chiamata: null,
      eseguita: false,
      saltato: true,
    };
  }
  return aggiornaTicket(ctx, { responder_id: id }, `Assegnazione all'agente ${id}`);
}

async function cambiaStato(a: Azione, ctx: Contesto): Promise<RisultatoNodo> {
  const stato = Number(a.parametri.stato);
  if (![2, 3, 4, 5].includes(stato)) {
    return {
      messaggio: `Stato non valido: «${a.parametri.stato}».`,
      chiamata: null,
      eseguita: false,
      saltato: true,
    };
  }
  return aggiornaTicket(ctx, { status: stato }, `Stato → «${STATO[stato]}»`);
}

async function rispondiSuGoogle(a: Azione, ctx: Contesto): Promise<RisultatoNodo> {
  const testo = interpola(a.parametri.testo ?? "", ctx.recensione);
  const esito = await rispondiARecensione({
    sede: ctx.recensione.sede,
    idRecensione: ctx.recensione.chiave.slice(0, 24),
    testo,
  });
  return {
    messaggio: `«${testo}» — ${esito.messaggio}`,
    chiamata: esito.chiamata,
    eseguita: esito.pubblicata,
  };
}

async function inoltraEmail(a: Azione, ctx: Contesto): Promise<RisultatoNodo> {
  const a_ = a.parametri.a || ctx.automation.emailEscalation;
  const testo = interpola(a.parametri.testo || ctx.automation.testoEscalation, ctx.recensione);
  const mailbox = await activeMailbox();

  const chiamata = {
    metodo: "POST",
    url: `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${ctx.recensione.messaggioId}/forward`,
    corpo: JSON.stringify(
      { comment: testo, toRecipients: [{ emailAddress: { address: a_ } }] },
      null,
      2,
    ),
  };

  if (!(await scritturaConsentita())) {
    return {
      messaggio: `Inoltro a ${a_} con «${testo}» — non inviato (modalità simulazione).`,
      chiamata,
      eseguita: false,
    };
  }

  await forwardMessage(ctx.recensione.messaggioId, [a_], testo, mailbox);
  return { messaggio: `Inoltrata a ${a_}.`, chiamata, eseguita: true };
}

// ------------------------------------------------------------------ dispatch

export async function eseguiAzione(a: Azione, ctx: Contesto): Promise<RisultatoNodo> {
  switch (a.tipo) {
    case "freshdesk.trovaTicket":
      return trovaTicket(ctx);
    case "freshdesk.classifica":
      return classifica(a, ctx);
    case "freshdesk.tag":
      return applicaTag(a, ctx);
    case "freshdesk.assegna":
      return assegna(a, ctx);
    case "freshdesk.stato":
      return cambiaStato(a, ctx);
    case "google.rispondi":
      return rispondiSuGoogle(a, ctx);
    case "email.inoltra":
      return inoltraEmail(a, ctx);
    case "sistema.attendiRisposta":
      return attendiRisposta(a, ctx);
    default: {
      const mai: never = a.tipo;
      throw new Error(`Azione sconosciuta: ${String(mai)}`);
    }
  }
}

export function titoloAzione(a: Azione): string {
  return CATALOGO[a.tipo]?.titolo ?? a.tipo;
}
