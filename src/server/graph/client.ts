import { activeMailbox, resolveGraph, type GraphConfig } from "@/server/settings";

// Client Microsoft Graph in modalità "app-only" (client credentials).
// La configurazione viene letta a ogni chiamata: le modifiche fatte in
// Impostazioni hanno effetto immediato, senza riavviare l'app.

export async function isGraphConfigured(): Promise<boolean> {
  const cfg = await resolveGraph();
  const mbx = await activeMailbox();
  return Boolean(cfg.tenantId && cfg.clientId && cfg.clientSecret && mbx);
}

// Cache del token in memoria, indicizzata per tenant+client: cambiando
// configurazione il vecchio token non viene riutilizzato.
const tokens = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(cfg: GraphConfig): Promise<string> {
  const cacheKey = `${cfg.tenantId}:${cfg.clientId}`;
  const hit = tokens.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) return hit.token;

  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
    cache: "no-store",
  });

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(`Autenticazione Microsoft fallita: ${data.error_description ?? res.status}`);
  }

  tokens.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  });
  return data.access_token;
}

/**
 * Contesto per una chiamata: il percorso base della casella e una `fetchGraph`
 * che aggiunge da sola l'header Authorization e `cache: no-store`.
 *
 * `fetchGraph` è resistente al token scaduto: se Graph risponde 401 — cosa che
 * su un PC-server sempre acceso capita quando l'orologio è fuori sincrono e il
 * token in cache "sembra" ancora valido ma non lo è più — svuota la cache del
 * token e ritenta UNA sola volta con un token appena emesso. Così l'errore
 * "Lifetime validation failed, the token is expired" si risolve da solo invece
 * di richiedere un riavvio dell'app.
 */
async function ctx(mailbox?: string): Promise<{
  base: string;
  fetchGraph: (path: string, init?: RequestInit) => Promise<Response>;
}> {
  const cfg = await resolveGraph();
  const mbx = mailbox || (await activeMailbox());
  const base = `${cfg.graphUrl}/users/${encodeURIComponent(mbx)}`;
  const cacheKey = `${cfg.tenantId}:${cfg.clientId}`;

  async function fetchGraph(path: string, init: RequestInit = {}): Promise<Response> {
    const esegui = (token: string) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      });

    let res = await esegui(await getAccessToken(cfg));
    if (res.status === 401) {
      tokens.delete(cacheKey);
      res = await esegui(await getAccessToken(cfg));
    }
    return res;
  }

  return { base, fetchGraph };
}

export type MailMessage = {
  id: string;
  conversationId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  receivedDateTime: string;
  preview: string;
  isRead: boolean;
  hasAttachments: boolean;
  webLink: string;
};

export type Recipient = { name: string; address: string };

export type MailDetail = MailMessage & {
  toRecipients: Recipient[];
  ccRecipients: Recipient[];
  bodyContent: string;
  bodyIsHtml: boolean;
};

type GraphRecipient = { emailAddress?: { name?: string; address?: string } };

type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string | null;
  bodyPreview?: string | null;
  receivedDateTime: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  body?: { contentType?: string; content?: string };
};

const LIST_FIELDS =
  "id,conversationId,subject,bodyPreview,receivedDateTime,isRead,hasAttachments,webLink,from";
const DETAIL_FIELDS = `${LIST_FIELDS},toRecipients,ccRecipients,body`;

function mapRecipients(list?: GraphRecipient[]): Recipient[] {
  return (list ?? [])
    .map((r) => ({ name: r.emailAddress?.name ?? "", address: r.emailAddress?.address ?? "" }))
    .filter((r) => r.address);
}

function toMessage(m: GraphMessage): MailMessage {
  const from = m.from?.emailAddress ?? m.sender?.emailAddress;
  return {
    id: m.id,
    conversationId: m.conversationId ?? "",
    subject: m.subject?.trim() || "(senza oggetto)",
    fromName: from?.name ?? "",
    fromAddress: from?.address ?? "",
    receivedDateTime: m.receivedDateTime,
    preview: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim(),
    isRead: m.isRead ?? true,
    hasAttachments: m.hasAttachments ?? false,
    webLink: m.webLink ?? "",
  };
}

function toDetail(m: GraphMessage): MailDetail {
  return {
    ...toMessage(m),
    toRecipients: mapRecipients(m.toRecipients),
    ccRecipients: mapRecipients(m.ccRecipients),
    bodyContent: m.body?.content ?? "",
    bodyIsHtml: (m.body?.contentType ?? "").toLowerCase() === "html",
  };
}

export type ListOptions = {
  top?: number;
  skip?: number;
  search?: string;
  unreadOnly?: boolean;
  mailbox?: string;
};

/** Legge i messaggi della Posta in arrivo. Ritorna anche il totale disponibile. */
export async function listInbox(
  opts: ListOptions = {},
): Promise<{ messages: MailMessage[]; total: number | null }> {
  const top = Math.min(opts.top ?? 25, 50);
  const skip = opts.skip ?? 0;
  const { fetchGraph } = await ctx(opts.mailbox);

  const params = new URLSearchParams({ $top: String(top), $select: LIST_FIELDS });

  // La ricerca full-text di Graph non è combinabile con $orderby/$filter/$count.
  if (opts.search) {
    params.set("$search", `"${opts.search.replace(/"/g, "")}"`);
  } else {
    params.set("$orderby", "receivedDateTime desc");
    params.set("$skip", String(skip));
    params.set("$count", "true");
    if (opts.unreadOnly) params.set("$filter", "isRead eq false");
  }

  const res = await fetchGraph(`/mailFolders/Inbox/messages?${params}`, {
    headers: { ConsistencyLevel: "eventual" },
  });

  const json = (await res.json()) as {
    value?: GraphMessage[];
    "@odata.count"?: number;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "errore sconosciuto"}`);
  }

  let messages = (json.value ?? []).map(toMessage);
  if (opts.search && opts.unreadOnly) messages = messages.filter((m) => !m.isRead);

  return { messages, total: json["@odata.count"] ?? null };
}

/** Legge un singolo messaggio, corpo incluso. NON lo segna come letto. */
export async function getMessage(id: string, mailbox?: string): Promise<MailDetail> {
  const { fetchGraph } = await ctx(mailbox);
  const params = new URLSearchParams({ $select: DETAIL_FIELDS });

  const res = await fetchGraph(`/messages/${encodeURIComponent(id)}?${params}`);

  const json = (await res.json()) as GraphMessage & { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "messaggio non trovato"}`);
  }
  return toDetail(json);
}

/**
 * Tutti i messaggi della stessa conversazione, in ordine cronologico.
 * Cerca su TUTTA la casella (non solo Inbox), così include anche le risposte
 * inviate: è il "flusso" completo come nei client di posta classici.
 */
export async function getConversation(
  conversationId: string,
  mailbox?: string,
): Promise<MailDetail[]> {
  if (!conversationId) return [];
  const { fetchGraph } = await ctx(mailbox);

  const params = new URLSearchParams({
    // L'apostrofo nei literal OData si raddoppia.
    $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
    $select: DETAIL_FIELDS,
    $top: "50",
  });

  const res = await fetchGraph(`/messages?${params}`);

  const json = (await res.json()) as { value?: GraphMessage[]; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "conversazione non trovata"}`);
  }

  // Ordinamento lato applicazione: $orderby insieme a $filter su conversationId
  // non è sempre accettato da Exchange.
  return (json.value ?? [])
    .map(toDetail)
    .sort(
      (a, b) => new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
    );
}

/**
 * Le NOTIFICHE delle recensioni (oggetto che contiene il testo cercato) più
 * recenti, col corpo incluso.
 *
 * La casella è enorme (decine di migliaia di email) e molto attiva: le notifiche
 * di Zapier sono interlacciate con tante conferme «Ticket Creato». E Graph non
 * aiuta: $search ordina per RILEVANZA (salta le recensioni recenti — caso reale:
 * Arthur Lavallée, 5★ di oggi, non compariva), e $filter su oggetto/mittente NON
 * si può combinare con $orderby su receivedDateTime ("restriction too complex").
 *
 * Quindi si SCORRE la Posta in arrivo ordinata per DATA (receivedDateTime desc),
 * pagina per pagina, tenendo solo le notifiche delle recensioni (oggetto giusto,
 * escluse le conferme «Ticket Creato»), finché non se ne raccolgono abbastanza o
 * si esauriscono le pagine. Così le recensioni recenti ci sono sempre.
 */
export async function searchMessages(opts: {
  subjectContains: string;
  fromContains?: string;
  top?: number;
  mailbox?: string;
}): Promise<MailDetail[]> {
  if (!opts.subjectContains.trim()) return [];
  const { fetchGraph } = await ctx(opts.mailbox);

  const oggetto = opts.subjectContains.trim().toLowerCase();
  const mittente = (opts.fromContains ?? "").trim().toLowerCase();
  const voluti = Math.min(opts.top ?? 60, 200);
  const MAX_PAGINE = 8;

  const risultati: MailDetail[] = [];
  const params = new URLSearchParams({
    $orderby: "receivedDateTime desc",
    $select: DETAIL_FIELDS,
    $top: "100",
  });
  let path: string | null = `/mailFolders/Inbox/messages?${params}`;

  for (let pagina = 0; path && pagina < MAX_PAGINE && risultati.length < voluti; pagina++) {
    const res = await fetchGraph(path);
    const json = (await res.json()) as {
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(`Graph ${res.status}: ${json.error?.message ?? "lettura non riuscita"}`);
    }

    for (const m of (json.value ?? []).map(toDetail)) {
      const s = m.subject.toLowerCase();
      if (!s.includes(oggetto)) continue;
      if (s.startsWith("ticket creato")) continue; // conferma Freshdesk, non una recensione
      if (mittente && !m.fromAddress.toLowerCase().includes(mittente)) continue;
      risultati.push(m);
    }

    // @odata.nextLink è un URL assoluto: si tiene la parte relativa (fetchGraph
    // riaggiunge da sé la base della casella).
    const next = json["@odata.nextLink"];
    const i = next ? next.indexOf("/mailFolders") : -1;
    path = i >= 0 ? next!.substring(i) : null;
  }

  return risultati.sort(
    (a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime(),
  );
}

/**
 * Scorre una cartella (Posta in arrivo o Posta inviata) dalla più recente
 * all'indietro fino a `since`, col corpo, e passa OGNI messaggio (filtrato per
 * oggetto) a `onMessage` — in streaming, senza tenere in memoria migliaia di
 * corpi HTML. Serve alle importazioni lunghe (es. la Memoria: un anno di
 * risposte inviate). Come in searchMessages, $filter non si combina con
 * $orderby per data: si filtra lato applicazione.
 */
export async function forEachMessageInFolder(
  opts: {
    folder: "Inbox" | "SentItems";
    since: Date;
    subjectContains?: string;
    mailbox?: string;
    maxPages?: number;
    onPage?: (info: { pagina: number; letti: number; tenuti: number; ultimaData: string }) => void;
  },
  onMessage: (m: MailDetail) => Promise<void> | void,
): Promise<{ pagine: number; letti: number; tenuti: number; raggiuntoTaglio: boolean }> {
  const { fetchGraph } = await ctx(opts.mailbox);
  const oggetto = (opts.subjectContains ?? "").trim().toLowerCase();
  const maxPages = opts.maxPages ?? 150;
  const sinceMs = opts.since.getTime();

  const params = new URLSearchParams({
    $orderby: "receivedDateTime desc",
    $select: DETAIL_FIELDS,
    $top: "100",
  });
  let path: string | null = `/mailFolders/${opts.folder}/messages?${params}`;

  let pagine = 0;
  let letti = 0;
  let tenuti = 0;
  let raggiuntoTaglio = false;

  type Pagina = {
    value?: GraphMessage[];
    "@odata.nextLink"?: string;
    error?: { message?: string };
  };

  while (path && pagine < maxPages && !raggiuntoTaglio) {
    // Un 429/5xx passeggero non deve far morire un'importazione di 70 pagine.
    let json: Pagina | null = null;
    for (let tentativo = 0; tentativo < 3 && !json; tentativo++) {
      const res = await fetchGraph(path);
      if (res.ok) {
        json = (await res.json()) as Pagina;
        break;
      }
      if (res.status === 429 || res.status >= 500) {
        const attesa = Math.min(Number(res.headers.get("retry-after")) || 2, 10);
        await new Promise((ok) => setTimeout(ok, attesa * 1000));
        continue;
      }
      const err = (await res.json().catch(() => ({}))) as Pagina;
      throw new Error(`Graph ${res.status}: ${err.error?.message ?? "lettura non riuscita"}`);
    }
    if (!json) throw new Error("Graph: errore persistente durante la scansione della cartella");

    pagine++;
    let ultimaData = "";
    for (const g of json.value ?? []) {
      letti++;
      ultimaData = g.receivedDateTime;
      if (new Date(g.receivedDateTime).getTime() < sinceMs) {
        raggiuntoTaglio = true;
        break;
      }
      const m = toDetail(g);
      if (oggetto && !m.subject.toLowerCase().includes(oggetto)) continue;
      tenuti++;
      await onMessage(m);
    }
    opts.onPage?.({ pagina: pagine, letti, tenuti, ultimaData });

    const next = json["@odata.nextLink"];
    const i = next ? next.indexOf("/mailFolders") : -1;
    path = i >= 0 ? next!.substring(i) : null;
  }

  return { pagine, letti, tenuti, raggiuntoTaglio };
}

/** Segna un messaggio come letto o non letto (richiede Mail.ReadWrite). */
export async function setReadState(id: string, isRead: boolean, mailbox?: string): Promise<void> {
  const { fetchGraph } = await ctx(mailbox);

  const res = await fetchGraph(`/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isRead }),
  });

  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "aggiornamento non riuscito"}`);
  }
}

/**
 * Risponde a un messaggio.
 *
 * Senza destinatari espliciti la risposta segue l'intestazione Reply-To del
 * messaggio originale: le email di Zapier hanno Reply-To
 * customer.care@galdierirent.it, ed è lì che finisce la risposta di Stefania.
 *
 * ATTENZIONE: invia posta reale. Passa dal connettore in
 * automation/connectors.ts, che prima verifica la modalità operativa.
 */
export async function replyToMessage(
  id: string,
  commento: string,
  destinatari: string[] = [],
  mailbox?: string,
): Promise<void> {
  const { fetchGraph } = await ctx(mailbox);

  const corpo: Record<string, unknown> = { comment: commento };
  if (destinatari.length > 0) {
    corpo.message = {
      toRecipients: destinatari.map((address) => ({ emailAddress: { address } })),
    };
  }

  const res = await fetchGraph(`/messages/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });

  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "risposta non inviata"}`);
  }
}

/**
 * Inoltra un messaggio a uno o più destinatari.
 *
 * ATTENZIONE: invia posta reale. Non va mai chiamata direttamente da una
 * pagina: passa dal connettore in automation/connectors.ts, che prima verifica
 * la modalità operativa.
 */
export async function forwardMessage(
  id: string,
  destinatari: string[],
  commento: string,
  mailbox?: string,
  copiaConoscenza: string[] = [],
): Promise<void> {
  const { fetchGraph } = await ctx(mailbox);

  // Il CC NON è un dettaglio: negli inoltri delle recensioni negative è la copia
  // a customer.care che fa NASCERE il ticket su Freshdesk. Senza, il messaggio
  // arriva al collega ma non viene tracciato — ed è ciò che succedeva.
  //
  // ⚠️ L'azione Graph POST /forward IGNORA il CC (accetta solo comment +
  // toRecipients): un `ccRecipients` nel corpo viene scartato in silenzio, così
  // l'inoltro partiva SENZA copia e il ticket non si creava (verificato sulla
  // Posta inviata: gli inoltri del software erano «FW:…» con CC vuoto, quelli
  // manuali «I:…» con CC pieno). Per includere davvero il CC si fa in tre passi:
  //   1) createForward  → crea una BOZZA di inoltro (col commento);
  //   2) PATCH la bozza → imposta destinatari E copia conoscenza;
  //   3) send la bozza  → la invia.
  const crea = await fetchGraph(`/messages/${encodeURIComponent(id)}/createForward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comment: commento }),
  });
  if (!crea.ok) {
    const j = (await crea.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Graph ${crea.status}: ${j.error?.message ?? "createForward non riuscito"}`);
  }
  const bozza = (await crea.json()) as { id?: string };
  const draftId = bozza.id;
  if (!draftId) throw new Error("Graph: bozza di inoltro senza id.");

  const patchBody: Record<string, unknown> = {
    toRecipients: destinatari.map((address) => ({ emailAddress: { address } })),
  };
  if (copiaConoscenza.length > 0) {
    patchBody.ccRecipients = copiaConoscenza.map((address) => ({ emailAddress: { address } }));
  }
  const patch = await fetchGraph(`/messages/${encodeURIComponent(draftId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patchBody),
  });
  if (!patch.ok) {
    const j = (await patch.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Graph ${patch.status}: ${j.error?.message ?? "destinatari/CC non impostati"}`);
  }

  const inv = await fetchGraph(`/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
  if (!inv.ok) {
    const j = (await inv.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Graph ${inv.status}: ${j.error?.message ?? "invio inoltro non riuscito"}`);
  }
}

/** Prova la connessione: token + lettura di un messaggio dalla casella. */
export async function testGraphConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const cfg = await resolveGraph();
    const mbx = await activeMailbox();
    if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) {
      return { ok: false, message: "Configurazione incompleta (tenant, client o segreto)." };
    }
    if (!mbx) return { ok: false, message: "Nessuna casella impostata." };

    const { messages, total } = await listInbox({ top: 1 });
    return {
      ok: true,
      message: `Connesso a ${mbx}${total !== null ? ` — ${total} email` : ""}${
        messages[0] ? `, ultima: "${messages[0].subject.slice(0, 50)}"` : ""
      }`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Errore sconosciuto" };
  }
}
