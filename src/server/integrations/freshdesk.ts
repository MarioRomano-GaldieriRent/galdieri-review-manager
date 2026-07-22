import { resolveFreshdesk } from "@/server/settings";

// Integrazione Freshdesk (ticketing) — SOLA LETTURA.
// Tutte le chiamate qui sotto sono GET: nessuna funzione crea, modifica o
// chiude ticket. Se in futuro servirà la scrittura andrà aggiunta
// esplicitamente, con conferma dell'utente.
//
// Autenticazione: HTTP Basic con la API key come username e "X" come password
// (metodo documentato da Freshdesk). La chiave sta nel profilo agente.

export const STATO: Record<number, string> = {
  2: "Aperto",
  3: "In attesa",
  4: "Risolto",
  5: "Chiuso",
};

export const PRIORITA: Record<number, string> = {
  1: "Bassa",
  2: "Media",
  3: "Alta",
  4: "Urgente",
};

export async function isFreshdeskConfigured(): Promise<boolean> {
  const cfg = await resolveFreshdesk();
  return Boolean(cfg.domain && cfg.apiKey);
}

function cleanDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function fdFetch(pathAndQuery: string): Promise<Response> {
  const cfg = await resolveFreshdesk();
  if (!cfg.domain || !cfg.apiKey) throw new Error("Freshdesk non configurato.");
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;
  return fetch(`https://${cleanDomain(cfg.domain)}/api/v2${pathAndQuery}`, {
    headers: { Authorization: auth, "Content-Type": "application/json" },
    cache: "no-store",
  });
}

export async function ticketUrl(id: number): Promise<string> {
  const cfg = await resolveFreshdesk();
  return `https://${cleanDomain(cfg.domain)}/a/tickets/${id}`;
}

export type FdTicket = {
  id: number;
  subject: string;
  status: number;
  priority: number;
  type: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  requesterName: string;
  requesterEmail: string;
  responderId: number | null;
  descriptionHtml: string;
};

type RawTicket = {
  id: number;
  subject?: string;
  status: number;
  priority: number;
  type?: string | null;
  tags?: string[];
  created_at: string;
  updated_at: string;
  responder_id?: number | null;
  description?: string;
  requester?: { name?: string; email?: string };
};

function toTicket(t: RawTicket): FdTicket {
  return {
    id: t.id,
    subject: t.subject?.trim() || "(senza oggetto)",
    status: t.status,
    priority: t.priority,
    type: t.type ?? null,
    tags: t.tags ?? [],
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    requesterName: t.requester?.name ?? "",
    requesterEmail: t.requester?.email ?? "",
    responderId: t.responder_id ?? null,
    descriptionHtml: t.description ?? "",
  };
}

/** Elenco ticket più recenti (paginato). */
export async function listTickets(opts: { page?: number; perPage?: number } = {}): Promise<{
  tickets: FdTicket[];
  hasMore: boolean;
}> {
  const perPage = Math.min(opts.perPage ?? 30, 100);
  const page = Math.max(1, opts.page ?? 1);
  const res = await fdFetch(
    `/tickets?per_page=${perPage}&page=${page}&order_by=created_at&order_type=desc&include=requester`,
  );
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: elenco ticket non disponibile.`);
  const raw = (await res.json()) as RawTicket[];
  return { tickets: raw.map(toTicket), hasMore: raw.length === perPage };
}

/** Ricerca per stato usando l'API di ricerca (conteggio affidabile). */
export async function searchTicketsByStatus(
  status: number,
  page = 1,
): Promise<{ tickets: FdTicket[]; total: number }> {
  const query = encodeURIComponent(`"status:${status}"`);
  const res = await fdFetch(`/search/tickets?query=${query}&page=${Math.max(1, page)}`);
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: ricerca non disponibile.`);
  const data = (await res.json()) as { results?: RawTicket[]; total?: number };
  return { tickets: (data.results ?? []).map(toTicket), total: data.total ?? 0 };
}

export async function getTicket(id: number): Promise<FdTicket> {
  const res = await fdFetch(`/tickets/${id}?include=requester`);
  if (res.status === 404) throw new Error("Ticket non trovato.");
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: ticket non disponibile.`);
  return toTicket((await res.json()) as RawTicket);
}

export type FdConversation = {
  id: number;
  bodyHtml: string;
  incoming: boolean;
  isPrivate: boolean;
  createdAt: string;
  fromEmail: string;
  userId: number | null;
};

/** Messaggi e note del ticket, in ordine cronologico. */
export async function getConversations(id: number): Promise<FdConversation[]> {
  const res = await fdFetch(`/tickets/${id}/conversations?per_page=50`);
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: conversazione non disponibile.`);
  const raw = (await res.json()) as {
    id: number;
    body?: string;
    incoming?: boolean;
    private?: boolean;
    created_at: string;
    from_email?: string;
    user_id?: number;
  }[];
  return raw
    .map((c) => ({
      id: c.id,
      bodyHtml: c.body ?? "",
      incoming: c.incoming ?? false,
      isPrivate: c.private ?? false,
      createdAt: c.created_at,
      fromEmail: c.from_email ?? "",
      userId: c.user_id ?? null,
    }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** Toglie prefissi di risposta/inoltro per confrontare due oggetti. */
function normalizzaOggetto(s: string): string {
  return s
    .replace(/^\s*((r|re|i|fw|fwd|rif)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function soloTesto(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Cerca il ticket nato da una recensione.
 *
 * L'oggetto da solo NON basta a identificarlo: ogni recensione della stessa
 * sede produce un oggetto identico ("NUOVA RECENSIONE GOOGLE Point Cagliari"),
 * quindi confrontare solo l'oggetto aggancia il ticket di un altro cliente.
 * Servono tre condizioni insieme:
 *
 *   1. stesso oggetto, tolti i prefissi di risposta/inoltro;
 *   2. il ticket non può essere nato prima dell'email che lo ha generato
 *      (si concede qualche minuto di tolleranza sugli orologi);
 *   3. il nome di chi ha scritto la recensione deve comparire nel corpo.
 *
 * Se nessun ticket soddisfa tutte e tre, si restituisce null con il motivo:
 * meglio saltare i passaggi su Freshdesk che lavorare il ticket sbagliato.
 *
 * Sola lettura: solo GET, non modifica nulla.
 */
export async function cercaTicketPerRecensione(
  oggetto: string,
  ricevutaIl: string,
  nomeRecensore: string,
  opts: { pagine?: number; candidatiMax?: number } = {},
): Promise<{ ticket: FdTicket | null; motivo: string }> {
  const atteso = normalizzaOggetto(oggetto);
  if (!atteso) return { ticket: null, motivo: "oggetto vuoto" };

  // Tolleranza: il ticket nasce dalla risposta all'email, quindi dopo di essa.
  const soglia = new Date(ricevutaIl).getTime() - 5 * 60 * 1000;
  const nome = nomeRecensore.trim().toLowerCase();

  const candidati: { t: FdTicket; distanza: number }[] = [];
  let stessoOggetto = 0;
  let esaminati = 0;

  // Sei pagine da cento. Con circa 120 recensioni a settimana più il resto del
  // traffico, trecento ticket coprivano appena due giorni: le recensioni di
  // qualche giorno prima restavano fuori e risultavano "senza ticket".
  const pagine = opts.pagine ?? 6;

  for (let page = 1; page <= pagine; page++) {
    const { tickets, hasMore } = await listTickets({ page, perPage: 100 });
    esaminati += tickets.length;
    for (const t of tickets) {
      if (normalizzaOggetto(t.subject) !== atteso) continue;
      stessoOggetto++;
      const creato = new Date(t.createdAt).getTime();
      if (creato < soglia) continue;
      candidati.push({ t, distanza: creato - soglia });
    }
    if (!hasMore) break;
  }

  if (candidati.length === 0) {
    return {
      ticket: null,
      motivo: stessoOggetto
        ? `${stessoOggetto} ticket con lo stesso oggetto, ma tutti precedenti all'email: nessuno nato da questa recensione`
        : `nessun ticket con questo oggetto fra gli ultimi ${esaminati} esaminati`,
    };
  }

  // Dal più vicino nel tempo; il corpo si legge solo per i primi candidati.
  candidati.sort((a, b) => a.distanza - b.distanza);
  const daControllare = candidati.slice(0, opts.candidatiMax ?? 5);

  if (!nome) {
    return {
      ticket: daControllare[0].t,
      motivo: "nome del recensore non disponibile: agganciato il ticket più vicino nel tempo",
    };
  }

  for (const { t } of daControllare) {
    const completo = await getTicket(t.id);
    if (soloTesto(completo.descriptionHtml).includes(nome)) {
      return { ticket: completo, motivo: `nome «${nomeRecensore}» trovato nel corpo` };
    }
  }

  return {
    ticket: null,
    motivo: `${daControllare.length} ticket con oggetto e data compatibili, ma in nessuno compare «${nomeRecensore}»`,
  };
}

// Elenco agenti in cache: serve solo a mostrare un nome al posto di un id.
let agentCache: { at: number; byId: Map<number, string> } | null = null;

export async function getAgents(): Promise<Map<number, string>> {
  if (agentCache && Date.now() - agentCache.at < 300_000) return agentCache.byId;
  const byId = new Map<number, string>();
  try {
    const res = await fdFetch(`/agents?per_page=100`);
    if (res.ok) {
      const raw = (await res.json()) as { id: number; contact?: { name?: string } }[];
      for (const a of raw) byId.set(a.id, a.contact?.name ?? `Agente ${a.id}`);
    }
  } catch {
    // Non bloccante: senza nomi si mostra l'id.
  }
  agentCache = { at: Date.now(), byId };
  return byId;
}

/** Verifica le credenziali leggendo il profilo dell'agente collegato. */
export async function testFreshdesk(): Promise<{ ok: boolean; message: string }> {
  const cfg = await resolveFreshdesk();
  if (!cfg.domain || !cfg.apiKey) {
    return { ok: false, message: "Dominio o API key non impostati." };
  }
  try {
    const res = await fdFetch(`/agents/me`);
    if (res.status === 401) return { ok: false, message: "API key rifiutata (401)." };
    if (res.status === 404) {
      return { ok: false, message: "Dominio non trovato (404): controlla l'indirizzo." };
    }
    if (!res.ok) return { ok: false, message: `Freshdesk ha risposto ${res.status}.` };

    const me = (await res.json()) as { contact?: { name?: string; email?: string } };
    return {
      ok: true,
      message: `Connesso come ${me.contact?.name ?? "agente"} (${me.contact?.email ?? "?"})`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Errore sconosciuto" };
  }
}
