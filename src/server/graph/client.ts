// Client Microsoft Graph in modalità "app-only" (client credentials).
// Usa l'app registration esistente: legge le caselle del tenant senza login Microsoft.

const TENANT = process.env.MICROSOFT_TENANT_ID ?? "";
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET ?? "";
const GRAPH = process.env.GRAPH_API_URL ?? "https://graph.microsoft.com/v1.0";

/** Casella da mostrare in "Posta in arrivo". */
export const WATCHED_MAILBOX =
  process.env.MAIL_WATCH_ADDRESS ?? process.env.MICROSOFT_USER_EMAIL ?? "";

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

  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Autenticazione Microsoft fallita: ${data.error_description ?? res.status}`);
  }

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

export type MailMessage = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  receivedDateTime: string;
  preview: string;
  isRead: boolean;
  hasAttachments: boolean;
  webLink: string;
};

type GraphMessage = {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  receivedDateTime: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
};

export type ListOptions = {
  top?: number;
  skip?: number;
  search?: string;
  mailbox?: string;
};

/** Legge i messaggi della Posta in arrivo. Ritorna anche il totale disponibile. */
export async function listInbox(
  opts: ListOptions = {},
): Promise<{ messages: MailMessage[]; total: number | null }> {
  const mailbox = opts.mailbox || WATCHED_MAILBOX;
  const top = Math.min(opts.top ?? 25, 50);
  const skip = opts.skip ?? 0;
  const token = await getAccessToken();

  const params = new URLSearchParams({
    $top: String(top),
    $select: "id,subject,bodyPreview,receivedDateTime,isRead,hasAttachments,webLink,from",
  });

  // La ricerca full-text di Graph non è combinabile con $orderby/$count.
  if (opts.search) {
    params.set("$search", `"${opts.search.replace(/"/g, "")}"`);
  } else {
    params.set("$orderby", "receivedDateTime desc");
    params.set("$skip", String(skip));
    params.set("$count", "true");
  }

  const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages?${params}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ConsistencyLevel: "eventual",
    },
    cache: "no-store",
  });

  const json = (await res.json()) as {
    value?: GraphMessage[];
    "@odata.count"?: number;
    error?: { message?: string; code?: string };
  };

  if (!res.ok) {
    throw new Error(`Graph ${res.status}: ${json.error?.message ?? "errore sconosciuto"}`);
  }

  const messages = (json.value ?? []).map((m) => ({
    id: m.id,
    subject: m.subject?.trim() || "(senza oggetto)",
    fromName: m.from?.emailAddress?.name ?? "",
    fromAddress: m.from?.emailAddress?.address ?? "",
    receivedDateTime: m.receivedDateTime,
    preview: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim(),
    isRead: m.isRead ?? true,
    hasAttachments: m.hasAttachments ?? false,
    webLink: m.webLink ?? "",
  }));

  return { messages, total: json["@odata.count"] ?? null };
}
