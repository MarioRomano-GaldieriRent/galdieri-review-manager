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

/**
 * Esegue una fetch verso Freshdesk riprovando UNA sola volta sul 429 (rate
 * limit), e SOLO se l'attesa richiesta (header «Retry-After») è breve (≤3s), per
 * non bloccare il render. Vale sia per le letture (fdFetch) sia per le scritture
 * (chiusura ticket, nodi automazione), che così non falliscono per un 429
 * transitorio. Se serve più di 3s la si lascia fallire: i chiamanti degradano.
 */
export async function conRetry429(doFetch: () => Promise<Response>): Promise<Response> {
  let res = await doFetch();
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after") ?? "0");
    if (ra > 0 && ra <= 3) {
      await new Promise((ok) => setTimeout(ok, ra * 1000 + 200));
      res = await doFetch();
    }
  }
  return res;
}

async function fdFetch(pathAndQuery: string): Promise<Response> {
  const cfg = await resolveFreshdesk();
  if (!cfg.domain || !cfg.apiKey) throw new Error("Freshdesk non configurato.");
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;
  const url = `https://${cleanDomain(cfg.domain)}/api/v2${pathAndQuery}`;
  const opts = {
    headers: { Authorization: auth, "Content-Type": "application/json" },
    cache: "no-store" as const,
  };
  return conRetry429(() => fetch(url, opts));
}

/**
 * Il nome del recensore compare nel corpo del ticket come PAROLA INTERA?
 * `includes()` di sottostringa dava falsi agganci: un nome corto/comune (Ana,
 * Rosa, Lia) è sottostringa di parole normali nel commento di un ALTRO cliente
 * («settimana» contiene «ana», «generosa» contiene «rosa»), col rischio di
 * nascondere per errore una negativa MAI inoltrata. Qui si richiede il confine
 * di parola sul testo normalizzato, e per i nomi troppo corti (<3) non ci si
 * fida. `corpo` e `nome` sono già passati da perConfronto (minuscolo, senza
 * accenti, spazi compressi).
 */
function nomeNelCorpo(corpoConfr: string, nomeConfr: string): boolean {
  if (nomeConfr.length < 3) return false;
  const esc = nomeConfr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Confine = inizio/fine oppure QUALSIASI carattere non alfanumerico (spazio,
  // «:», «,», …): nel corpo il nome arriva come «nome:filip antic», dove prima
  // c'è il due punti, non uno spazio — con solo \s il match sfuggiva.
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(corpoConfr);
}

/** Solo lettere, cifre e spazi singoli: per cercare un testo dentro un altro senza badare a punteggiatura ed entità. */
function alfanumerico(s: string): string {
  return perConfronto(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * L'inizio del testo della recensione, ridotto: abbastanza lungo da non poter
 * capitare per caso in un altro ticket. Vuoto se la recensione è troppo corta
 * per fare da prova.
 */
function improntaTesto(testo: string): string {
  const r = alfanumerico(testo).slice(0, 60);
  return r.length >= 20 ? r : "";
}

/**
 * «Nome:D Commento:…» — nel corpo il nome sta subito dopo l'etichetta, e lì
 * anche un nome di una lettera è un aggancio esatto.
 */
function nomeEtichettato(corpoConfr: string, nomeConfr: string): boolean {
  if (!nomeConfr) return false;
  const esc = nomeConfr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`nome\\s*:\\s*${esc}\\s*(commento|punteggio|id)\\s*:`).test(corpoConfr);
}

/**
 * Il ticket è quello di questa recensione? Si guarda il CORPO, con tre prove:
 *  1. il nome a confine di parola — mai per i nomi sotto le 3 lettere, per
 *     prudenza: ma così il ticket di «D» non si agganciava MAI, e restava
 *     aperto anche dopo la risposta;
 *  2. il TESTO della recensione: il corpo la porta per intero («Commento:…»),
 *     ed è la prova che regge anche coi nomi corti. Quando il testo c'è ed è
 *     abbastanza lungo, decide LUI: un altro «D» con un'altra recensione non
 *     si aggancia;
 *  3. senza testo, il nome etichettato («Nome:D Commento:»), esatto anche se
 *     corto.
 * Esportata per il banco di prova (npm run banco:aggancio).
 */
export function agganciaPerCorpo(
  corpoHtml: string,
  nomeRecensore: string,
  testoRecensione = "",
): { ok: boolean; come: string } {
  const corpo = perConfronto(soloTesto(corpoHtml));
  const nomeConfr = perConfronto(nomeRecensore);
  if (nomeNelCorpo(corpo, nomeConfr)) {
    return { ok: true, come: `nome «${nomeRecensore}» trovato nel corpo` };
  }
  const impronta = improntaTesto(testoRecensione);
  if (impronta) {
    if (alfanumerico(corpo).includes(impronta)) {
      return { ok: true, come: `testo della recensione trovato nel corpo (recensore «${nomeRecensore}»)` };
    }
    return { ok: false, come: "" };
  }
  if (nomeEtichettato(corpo, nomeConfr)) {
    return { ok: true, come: `nome «${nomeRecensore}» trovato nel corpo come «Nome:…»` };
  }
  return { ok: false, come: "" };
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
  /**
   * true se il corpo (descriptionHtml) è stato davvero letto da Freshdesk: la
   * lista lo porta solo se chiesto con include=description, e un ticket senza
   * corpo caricato NON va confrontato per nome (descriptionHtml sarebbe "" per
   * costruzione, non perché il ticket è vuoto).
   */
  corpoCaricato: boolean;
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

function toTicket(t: RawTicket, conCorpo: boolean): FdTicket {
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
    // Chiave assente = corpo NON arrivato (ripiego getTicket in conCorpo);
    // "" = corpo letto e davvero vuoto. Così, se mai la lista arrivasse senza
    // corpi, le sweep tornerebbero alle GET (e al banner) invece di far
    // riapparire in silenzio le recensioni già gestite.
    corpoCaricato: conCorpo && t.description !== undefined,
  };
}

/** Cosa far includere a Freshdesk nell'elenco: ogni voce costa 1 credito in più per pagina. */
export type IncludiTicket = "requester" | "description";

/**
 * Elenco ticket più recenti (paginato).
 *
 * `includi`: "requester" porta nome/email di chi ha aperto il ticket (pagina
 * Ticket); "description" porta il CORPO di ogni ticket già nella lista, così
 * chi deve confrontare i corpi (sweep di «Da approvare», aggancio del ticket)
 * non fa più una GET per ticket. Misurato sul tenant: una pagina da 100 costa
 * 1 credito + 1 per ogni include (sul limite di 100 chiamate al minuto), e con
 * i corpi pesa ~1 MB invece di ~140 KB, senza essere più lenta.
 */
export async function listTickets(
  opts: { page?: number; perPage?: number; includi?: IncludiTicket[] } = {},
): Promise<{
  tickets: FdTicket[];
  hasMore: boolean;
}> {
  const perPage = Math.min(opts.perPage ?? 30, 100);
  const page = Math.max(1, opts.page ?? 1);
  const includi = opts.includi ?? ["requester"];
  const conCorpo = includi.includes("description");
  const include = includi.length > 0 ? `&include=${includi.join(",")}` : "";
  const res = await fdFetch(
    `/tickets?per_page=${perPage}&page=${page}&order_by=created_at&order_type=desc${include}`,
  );
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: elenco ticket non disponibile.`);
  const raw = (await res.json()) as RawTicket[];
  return { tickets: raw.map((t) => toTicket(t, conCorpo)), hasMore: raw.length === perPage };
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
  return { tickets: (data.results ?? []).map((t) => toTicket(t, false)), total: data.total ?? 0 };
}

// Cache breve dei singoli ticket letti col corpo. In app oggi quasi nessuno la
// legge: la pagina del ticket e la chiusura passano forza=true (vogliono lo
// stato fresco) e il ripiego di conCorpo non scatta finché le liste arrivano
// con include=description. Resta per gli script diag/chiudi-ticket e come rete
// di sicurezza se una lista senza corpi finisse in una sweep. TTL corto per non
// servire a lungo uno stato vecchio dopo una chiusura.
const cacheGetTicket = new Map<number, { at: number; ticket: FdTicket }>();
const TTL_GET_TICKET_MS = 60_000;

export async function getTicket(id: number, forza = false): Promise<FdTicket> {
  const hit = cacheGetTicket.get(id);
  if (!forza && hit && Date.now() - hit.at < TTL_GET_TICKET_MS) return hit.ticket;
  const res = await fdFetch(`/tickets/${id}?include=requester`);
  if (res.status === 404) throw new Error("Ticket non trovato.");
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: ticket non disponibile.`);
  const ticket = toTicket((await res.json()) as RawTicket, true);
  cacheGetTicket.set(id, { at: Date.now(), ticket });
  return ticket;
}

/**
 * Il ticket COL CORPO: quello della lista se la lista lo portava già
 * (include=description), altrimenti lo si legge — ripiego che costa una GET e
 * un credito, da tenere raro.
 */
async function conCorpo(t: FdTicket, forza?: boolean): Promise<FdTicket> {
  return t.corpoCaricato ? t : getTicket(t.id, forza);
}

/** Un errore di Freshdesk per limite di chiamate (HTTP 429)? */
function eLimiteChiamate(e: unknown): boolean {
  return e instanceof Error && /\b429\b/.test(e.message);
}

function messaggio(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

// Entità HTML degli accenti più comuni (Freshdesk a volte le lascia nel corpo).
const ENTITA_ACCENTI: Record<string, string> = {
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  aacute: "á", agrave: "à", acirc: "â", auml: "ä", aring: "å",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü",
  ntilde: "ñ", ccedil: "ç",
};

/**
 * Normalizza un testo PER CONFRONTO dei nomi: decodifica le entità HTML
 * (numeriche e le accentate più comuni) e TOGLIE gli accenti (NFD + rimozione
 * dei segni diacritici). Serve perché il nome del recensore arriva accentato
 * («Lavallée») mentre nel corpo del ticket può stare senza accento o come
 * entità — e un confronto letterale non aggancerebbe il ticket.
 */
function perConfronto(s: string): string {
  return (s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, nome) => ENTITA_ACCENTI[String(nome).toLowerCase()] ?? m)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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
 * Il ticket restituito viene dalla lista col corpo ma SENZA il richiedente
 * (requesterName/requesterEmail vuoti): nessun chiamante li legge, e ogni
 * include costa un credito a pagina. Chi ne avesse bisogno faccia getTicket.
 *
 * Sola lettura: solo GET, non modifica nulla.
 */
export async function cercaTicketPerRecensione(
  oggetto: string,
  ricevutaIl: string,
  nomeRecensore: string,
  opts: { pagine?: number; candidatiMax?: number; forza?: boolean; testoRecensione?: string } = {},
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
    // Solo il corpo (niente requester, vedi sopra): il confronto per nome più
    // sotto non fa GET. Due crediti a pagina.
    const { tickets, hasMore } = await listTickets({ page, perPage: 100, includi: ["description"] });
    esaminati += tickets.length;
    for (const t of tickets) {
      if (normalizzaOggetto(t.subject) !== atteso) continue;
      stessoOggetto++;
      const creato = new Date(t.createdAt).getTime();
      if (creato < soglia) continue;
      candidati.push({ t, distanza: creato - soglia });
    }
    if (!hasMore) break;
    // La lista è dal più recente: se l'ultimo di questa pagina è già più vecchio
    // della soglia, le pagine dopo non possono contenere candidati (creato >=
    // soglia). Fermarsi qui non cambia l'esito, e per il ticket appena nato da
    // un'escalation basta la prima pagina: 2 crediti invece di 12, per ognuno
    // dei tentativi di trovaTicket.
    const ultimo = tickets[tickets.length - 1];
    if (ultimo && new Date(ultimo.createdAt).getTime() < soglia) break;
  }

  if (candidati.length === 0) {
    return {
      ticket: null,
      motivo: stessoOggetto
        ? `${stessoOggetto} ticket con lo stesso oggetto, ma tutti precedenti all'email: nessuno nato da questa recensione`
        : `nessun ticket con questo oggetto fra gli ultimi ${esaminati} esaminati`,
    };
  }

  // Dal più vicino nel tempo (il ticket di solito nasce subito dopo la
  // recensione), ma se ne controllano PARECCHI: un ticket può essere creato
  // anche un giorno dopo (es. Arthur, recensione del 31 → ticket del 1°), e col
  // vecchio limite di 5 restava fuori. Il nome nel corpo è un forte
  // disambiguatore, quindi leggerne di più non aggancia il ticket sbagliato — e
  // i corpi sono già nella lista, non costano nulla (il ciclo si ferma al primo
  // match).
  candidati.sort((a, b) => a.distanza - b.distanza);
  const daControllare = candidati.slice(0, opts.candidatiMax ?? 25);

  if (!nome) {
    return {
      ticket: daControllare[0].t,
      motivo: "nome del recensore non disponibile: agganciato il ticket più vicino nel tempo",
    };
  }

  for (const { t } of daControllare) {
    const completo = await conCorpo(t, opts.forza);
    // Nome a confine di parola, TESTO della recensione, o nome etichettato:
    // vedi agganciaPerCorpo. Il testo è quello che aggancia anche «D».
    const prova = agganciaPerCorpo(completo.descriptionHtml, nomeRecensore, opts.testoRecensione);
    if (prova.ok) return { ticket: completo, motivo: prova.come };
  }

  return {
    ticket: null,
    motivo: `${daControllare.length} ticket con oggetto e data compatibili, ma in nessuno compare «${nomeRecensore}»${
      opts.testoRecensione ? " né il testo della recensione" : ""
    }`,
  };
}

// Elenco dei ticket recenti in cache (60s), COL CORPO: la sweep di 6 pagine è la
// parte più cara del filtro «Da approvare», e la home la ripagava a ogni
// caricamento: qui la si riusa fra render ravvicinati. Con i corpi già dentro,
// le sweep non fanno più una GET per ticket — era quel grappolo (fino a 25 per
// ogni negativa) a esaurire le 100 chiamate al minuto e a far saltare tutto il
// filtro. Costo fisso: 2 crediti a pagina, 12 per sweep; in memoria ~5 MB.
// Sola lettura; si azzera a un riavvio.
let cacheTicket: { at: number; pagine: number; tickets: FdTicket[] } | null = null;
const TTL_TICKET_MS = 60_000;

export async function elencoTicketRecenti(pagine: number, forza = false): Promise<FdTicket[]> {
  if (!forza && cacheTicket && cacheTicket.pagine >= pagine && Date.now() - cacheTicket.at < TTL_TICKET_MS) {
    return cacheTicket.tickets;
  }
  const tutti: FdTicket[] = [];
  for (let page = 1; page <= pagine; page++) {
    const { tickets, hasMore } = await listTickets({ page, perPage: 100, includi: ["description"] });
    tutti.push(...tickets);
    if (!hasMore) break;
  }
  cacheTicket = { at: Date.now(), pagine, tickets: tutti };
  return tutti;
}

/**
 * Esito di una sweep. Le sweep NON sollevano: se Freshdesk si ferma a metà,
 * ciò che era già CONFERMATO resta in `nascoste` e il resto si conta in
 * `nonVerificate`. Si nasconde solo il provato: una recensione non verificata
 * resta visibile, mai il contrario.
 *
 * Con la lista col corpo (elencoTicketRecenti) il ciclo non chiama Freshdesk,
 * quindi oggi l'unico errore possibile è quello della lista stessa: tutto o
 * niente. Il «fermarsi a metà» copre il ripiego getTicket di una lista passata
 * senza corpi (corpoCaricato=false).
 */
export type EsitoSweep = {
  /** Chiavi delle recensioni confermate (risolte / già inoltrate): da nascondere. */
  nascoste: Set<string>;
  /** Recensioni che non si è riusciti a verificare: restano visibili. */
  nonVerificate: number;
  /** L'ultimo errore incontrato, per dirlo a chi guarda la lista. */
  errore: string | null;
};

/**
 * Delle recensioni date, quali hanno il ticket GIÀ risolto/chiuso su Freshdesk.
 * Usata dalla lista "Da approvare" per togliere ciò che è già stato gestito.
 *
 * UNA sola sweep condivisa dei ticket (niente fan-out N×6). Per ogni recensione:
 *  - fra i ticket con quell'oggetto nati dopo l'email, se sono TUTTI risolti/
 *    chiusi → risolta (gratis, senza leggere i corpi);
 *  - se qualcuno è ancora APERTO, non si arrende: trova il ticket SPECIFICO
 *    della recensione leggendone il corpo (match per nome, senza accenti) e
 *    guarda LO STATO DI QUELLO. Così una recensione risolta sparisce anche se la
 *    stessa sede ha altri ticket aperti (es. Bari, molto attiva). I corpi sono
 *    già nella lista: si confrontano dal ticket più vicino nel tempo, fermandosi
 *    al primo che contiene il nome. Senza nome (o nessun match) resta prudente e
 *    la tiene. Sola lettura; non solleva (vedi EsitoSweep).
 */
export async function recensioniConTicketRisolto(
  recensioni: { chiave: string; oggetto: string; ricevutaIl: string; nome: string }[],
  opts: { pagine?: number; candidatiMax?: number; forza?: boolean; tickets?: FdTicket[] } = {},
): Promise<EsitoSweep> {
  const esito: EsitoSweep = { nascoste: new Set(), nonVerificate: 0, errore: null };
  if (recensioni.length === 0) return esito;

  // La lista può essere condivisa dal chiamante (scaricata UNA volta per le due
  // sweep); altrimenti la si prende dalla cache/da Freshdesk. Senza lista non si
  // verifica nulla: tutte restano visibili.
  let tutti: FdTicket[];
  try {
    tutti = opts.tickets ?? (await elencoTicketRecenti(opts.pagine ?? 6, opts.forza));
  } catch (e) {
    return { ...esito, nonVerificate: recensioni.length, errore: messaggio(e) };
  }
  const risolto = (t: FdTicket) => t.status === 4 || t.status === 5;

  for (let i = 0; i < recensioni.length; i++) {
    const r = recensioni[i];
    try {
      const atteso = normalizzaOggetto(r.oggetto);
      if (!atteso) continue;
      const soglia = new Date(r.ricevutaIl).getTime() - 5 * 60 * 1000;
      const candidati = tutti.filter(
        (t) => normalizzaOggetto(t.subject) === atteso && new Date(t.createdAt).getTime() >= soglia,
      );
      if (candidati.length === 0) continue;

      // Casella tutta risolta: gratis, nessun corpo da guardare.
      if (candidati.every(risolto)) {
        esito.nascoste.add(r.chiave);
        continue;
      }

      // Se NESSUN candidato è risolto, questa recensione non può essere «già
      // gestita» tramite loro: inutile guardare i corpi. Taglia il caso delle 5★
      // ancora da pubblicare in una sede con soli ticket negativi aperti.
      if (!candidati.some(risolto)) continue;

      // Qualcuno risolto e qualcuno aperto: trova il ticket SPECIFICO della
      // recensione (per nome) e guarda lo stato di QUELLO, dal più vicino nel
      // tempo, al primo match.
      const nomeConfr = perConfronto(r.nome || "");
      if (!nomeConfr) continue; // senza nome non disambiguo: prudente, la tengo
      const perTempo = [...candidati].sort(
        (a, b) =>
          Math.abs(new Date(a.createdAt).getTime() - soglia) -
          Math.abs(new Date(b.createdAt).getTime() - soglia),
      );
      for (const t of perTempo.slice(0, opts.candidatiMax ?? 25)) {
        const completo = await conCorpo(t, opts.forza);
        if (nomeNelCorpo(perConfronto(soloTesto(completo.descriptionHtml)), nomeConfr)) {
          if (risolto(completo)) esito.nascoste.add(r.chiave);
          break; // trovato il suo ticket: lo stato di quello è la risposta
        }
      }
    } catch (e) {
      // Questa non si è potuta verificare: resta visibile. Al limite di chiamate
      // è inutile insistere (ogni tentativo aspetterebbe e fallirebbe): ci si
      // ferma e si contano le rimanenti come non verificate. Scatta solo col
      // ripiego getTicket (lista senza corpi): con elencoTicketRecenti il ciclo
      // non fa chiamate.
      esito.errore = messaggio(e);
      if (eLimiteChiamate(e)) {
        esito.nonVerificate += recensioni.length - i;
        break;
      }
      esito.nonVerificate += 1;
    }
  }
  return esito;
}

/**
 * Delle recensioni date, quali hanno GIÀ un ticket su Freshdesk (qualsiasi
 * stato). Per le negative (1-2★) un ticket esiste solo se sono state inoltrate al
 * customer care: quindi «ha un ticket» = «già inoltrata», e "Da approvare" può
 * smettere di riproporne l'inoltro.
 *
 * A differenza di recensioniConTicketRisolto qui NON conta lo stato E NON conta
 * il tempo: la mail della recensione può essere un INOLTRO TARDIVO, col ticket
 * nato giorni PRIMA (es. Paula López, mail «Re: I: …» del 31/08, ticket del 26).
 * Quindi si guardano tutti i ticket con lo stesso oggetto (sede) nella finestra,
 * i più vicini nel tempo per primi, e a decidere è il NOME nel corpo. Senza nome
 * (o nessun match) resta prudente e NON la considera agganciata, così non si
 * nasconde per errore una non ancora inoltrata. Sola lettura; non solleva (vedi
 * EsitoSweep).
 */
export async function recensioniConTicket(
  recensioni: { chiave: string; oggetto: string; ricevutaIl: string; nome: string }[],
  opts: { pagine?: number; candidatiMax?: number; forza?: boolean; tickets?: FdTicket[] } = {},
): Promise<EsitoSweep> {
  const esito: EsitoSweep = { nascoste: new Set(), nonVerificate: 0, errore: null };
  if (recensioni.length === 0) return esito;

  let tutti: FdTicket[];
  try {
    tutti = opts.tickets ?? (await elencoTicketRecenti(opts.pagine ?? 6, opts.forza));
  } catch (e) {
    return { ...esito, nonVerificate: recensioni.length, errore: messaggio(e) };
  }

  for (let i = 0; i < recensioni.length; i++) {
    const r = recensioni[i];
    try {
      const atteso = normalizzaOggetto(r.oggetto);
      if (!atteso) continue;

      const nomeConfr = perConfronto(r.nome || "");
      if (!nomeConfr) continue; // senza nome non disambiguo: prudente, la tengo

      // Tutti i ticket della stessa sede, a QUALSIASI ora; i più vicini nel tempo
      // alla recensione per primi (efficienza). Il match giusto lo fa il nome.
      const rif = new Date(r.ricevutaIl).getTime();
      const candidati = tutti
        .filter((t) => normalizzaOggetto(t.subject) === atteso)
        .sort(
          (a, b) =>
            Math.abs(new Date(a.createdAt).getTime() - rif) -
            Math.abs(new Date(b.createdAt).getTime() - rif),
        );

      // Fino a 25 come le altre funzioni: qui il ticket dell'INOLTRO TARDIVO è
      // lontano nel tempo (finisce in fondo all'ordinamento), quindi un cap basso
      // lo tagliava fuori (falso «da inoltrare» → doppione). I corpi sono già
      // nella lista: guardarne 25 non costa chiamate.
      for (const t of candidati.slice(0, opts.candidatiMax ?? 25)) {
        const completo = await conCorpo(t, opts.forza);
        if (nomeNelCorpo(perConfronto(soloTesto(completo.descriptionHtml)), nomeConfr)) {
          esito.nascoste.add(r.chiave); // il suo ticket esiste: è già stata inoltrata
          break;
        }
      }
    } catch (e) {
      // Come sopra: solo col ripiego getTicket; al 429 ci si ferma.
      esito.errore = messaggio(e);
      if (eLimiteChiamate(e)) {
        esito.nonVerificate += recensioni.length - i;
        break;
      }
      esito.nonVerificate += 1;
    }
  }
  return esito;
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

// Id dell'agente dell'API in cache: serve ad assegnare i ticket da risolvere.
let agenteApiCache: { at: number; id: number | null } | null = null;

/**
 * L'id dell'agente a cui appartiene la API key (GET /agents/me). Freshdesk non
 * risolve un ticket NON assegnato: quando manca il responder, la chiusura gli
 * assegna questo agente. null se non lo si riesce a leggere. Sola lettura.
 */
export async function agenteApiId(): Promise<number | null> {
  if (agenteApiCache && Date.now() - agenteApiCache.at < 300_000) return agenteApiCache.id;
  let id: number | null = null;
  try {
    const res = await fdFetch(`/agents/me`);
    if (res.ok) {
      const me = (await res.json()) as { id?: number };
      id = typeof me.id === "number" ? me.id : null;
    }
  } catch {
    // Non bloccante: senza id la chiusura riproverà senza assegnare.
  }
  agenteApiCache = { at: Date.now(), id };
  return id;
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
