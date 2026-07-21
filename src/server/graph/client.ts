// Client Microsoft Graph in modalità "app-only" (client credentials).
// Usa l'app registration esistente: legge e aggiorna le caselle del tenant.

const TENANT = process.env.MICROSOFT_TENANT_ID ?? "";
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET ?? "";
const GRAPH = process.env.GRAPH_API_URL ?? "https://graph.microsoft.com/v1.0";

/** Casella da mostrare in "Posta in arrivo". */
export const WATCHED_MAILBOX = process.env.MAIL_WATCH_ADDRESS ?? "";

export function isGraphConfigured(): boolean {
  return Boolean(TENANT && CLIENT_ID && CLIENT_SECRET && WATCHED_MAILBOX);
}

// Cache del token in memoria (scade dopo ~1h, lo rinnoviamo 60s prima).
let cached: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
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

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

function mailboxPath(mailbox?: string): string {
  return `${GRAPH}/users/${encodeURIComponent(mailbox || WATCHED_MAILBOX)}`;
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
    .map((r) => ({
      name: r.emailAddress?.name ?? "",
      address: r.emailAddress?.address ?? "",
    }))
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
  const token = await getAccessToken();

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

  const url = `${mailboxPath(opts.mailbox)}/mailFolders/Inbox/messages?${params}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" },
    cache: "no-store",
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
  const token = await getAccessToken();
  const params = new URLSearchParams({ $select: DETAIL_FIELDS });
  const url = `${mailboxPath(mailbox)}/messages/${encodeURIComponent(id)}?${params}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

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
  const token = await getAccessToken();

  const params = new URLSearchParams({
    // L'apostrofo nei literal OData si raddoppia.
    $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
    $select: DETAIL_FIELDS,
    $top: "50",
  });
  const url = `${mailboxPath(mailbox)}/messages?${params}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const json = (await res.json()) as { value?: GraphMessage[]; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "conversazione non trovata"}`);
  }

  // Ordinamento lato applicazione: $orderby insieme a $filter su conversationId
  // non è sempre accettato da Exchange.
  return (json.value ?? [])
    .map(toDetail)
    .sort(
      (a, b) =>
        new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
    );
}

/**
 * Cerca i messaggi il cui OGGETTO contiene un testo, con il corpo incluso.
 * Cerca su tutta la casella così prende anche risposte e notifiche del flusso.
 */
export async function searchMessages(opts: {
  subjectContains: string;
  fromContains?: string;
  top?: number;
  mailbox?: string;
}): Promise<MailDetail[]> {
  if (!opts.subjectContains.trim()) return [];
  const token = await getAccessToken();

  const params = new URLSearchParams({
    $search: `"subject:${opts.subjectContains.replace(/"/g, "")}"`,
    $select: DETAIL_FIELDS,
    $top: String(Math.min(opts.top ?? 50, 100)),
  });
  const url = `${mailboxPath(opts.mailbox)}/messages?${params}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" },
    cache: "no-store",
  });

  const json = (await res.json()) as { value?: GraphMessage[]; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "ricerca non riuscita"}`);
  }

  const needle = (opts.fromContains ?? "").trim().toLowerCase();
  return (json.value ?? [])
    .map(toDetail)
    .filter((m) => !needle || m.fromAddress.toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime(),
    );
}

/** Segna un messaggio come letto o non letto (richiede Mail.ReadWrite). */
export async function setReadState(id: string, isRead: boolean, mailbox?: string): Promise<void> {
  const token = await getAccessToken();
  const url = `${mailboxPath(mailbox)}/messages/${encodeURIComponent(id)}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ isRead }),
    cache: "no-store",
  });

  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "aggiornamento non riuscito"}`);
  }
}
