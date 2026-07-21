import { resolveFreshdesk } from "@/server/settings";

// Integrazione Freshdesk (ticketing).
// Stato: configurabile e verificabile. La creazione/aggiornamento dei ticket
// sarà il passo successivo.
//
// Autenticazione: HTTP Basic con la API key come username e "X" come password
// (è il metodo documentato da Freshdesk). La chiave si trova nel profilo agente
// → "View API Key".

export async function isFreshdeskConfigured(): Promise<boolean> {
  const cfg = await resolveFreshdesk();
  return Boolean(cfg.domain && cfg.apiKey);
}

function baseUrl(domain: string): string {
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${clean}/api/v2`;
}

function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`;
}

/** Verifica le credenziali leggendo il profilo dell'agente collegato. */
export async function testFreshdesk(): Promise<{ ok: boolean; message: string }> {
  const cfg = await resolveFreshdesk();
  if (!cfg.domain || !cfg.apiKey) {
    return { ok: false, message: "Dominio o API key non impostati." };
  }

  try {
    const res = await fetch(`${baseUrl(cfg.domain)}/agents/me`, {
      headers: { Authorization: authHeader(cfg.apiKey), "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (res.status === 401) return { ok: false, message: "API key rifiutata (401)." };
    if (res.status === 404) {
      return { ok: false, message: "Dominio non trovato (404): controlla l'indirizzo." };
    }
    if (!res.ok) {
      return { ok: false, message: `Freshdesk ha risposto ${res.status}.` };
    }

    const me = (await res.json()) as {
      contact?: { name?: string; email?: string };
      available?: boolean;
    };
    return {
      ok: true,
      message: `Connesso come ${me.contact?.name ?? "agente"} (${me.contact?.email ?? "?"})`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Errore sconosciuto" };
  }
}
