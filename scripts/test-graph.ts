import { readFileSync } from "fs";
import path from "path";

// Carica le variabili da .env (tsx non lo fa automaticamente).
function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (!v.startsWith('"') && !v.startsWith("'")) {
      const c = v.indexOf(" #");
      if (c >= 0) v = v.slice(0, c).trim();
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const tenant = process.env.MICROSOFT_TENANT_ID ?? "";
const clientId = process.env.MICROSOFT_CLIENT_ID ?? "";
const secret = process.env.MICROSOFT_CLIENT_SECRET ?? "";
const graph = process.env.GRAPH_API_URL ?? "https://graph.microsoft.com/v1.0";

const mailboxes = [process.env.MAIL_WATCH_ADDRESS ?? ""].filter(Boolean);

async function main() {
  console.log("Tenant ID :", tenant);
  console.log("Client ID :", clientId);
  console.log("Secret    :", secret ? `presente (${secret.length} caratteri)` : "MANCANTE");

  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok || typeof data.access_token !== "string") {
    console.log(`\n❌ Token FALLITO (HTTP ${res.status})`);
    console.log("   error:", data.error);
    console.log("   descrizione:", String(data.error_description ?? "").slice(0, 400));
    return;
  }

  const token = data.access_token;
  console.log(`\n✅ Token ottenuto (valido ${data.expires_in} secondi)`);

  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    );
    console.log("   Permessi applicativi (roles):", payload.roles ?? "(nessuno)");
    console.log("   App:", payload.app_displayname ?? "-");
  } catch {
    console.log("   (impossibile decodificare il token)");
  }

  for (const mbx of mailboxes) {
    console.log(`\n=== Inbox di ${mbx} ===`);
    const url =
      `${graph}/users/${encodeURIComponent(mbx)}/mailFolders/Inbox/messages` +
      `?$top=5&$select=subject,receivedDateTime,from`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = (await r.json()) as any;

    if (!r.ok) {
      console.log(`  ❌ HTTP ${r.status} — ${j?.error?.code}`);
      console.log(`     ${String(j?.error?.message ?? "").slice(0, 250)}`);
      continue;
    }

    console.log(`  ✅ Accesso OK — ${j.value?.length ?? 0} messaggi letti`);
    for (const m of j.value ?? []) {
      const from = m.from?.emailAddress?.address ?? "?";
      const stato = m.isRead === false ? "NON LETTA" : "letta";
      console.log(`   • [${stato}] ${String(m.receivedDateTime).slice(0, 16)} | ${from} | ${m.subject}`);
    }

    // Quante non lette ci sono in totale nella Posta in arrivo?
    const cntUrl =
      `${graph}/users/${encodeURIComponent(mbx)}/mailFolders/Inbox/messages` +
      `?$filter=isRead eq false&$count=true&$top=1&$select=id`;
    const cr = await fetch(cntUrl, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" },
    });
    const cj = (await cr.json()) as any;
    if (cr.ok) {
      console.log(`  📬 Email NON LETTE nella Posta in arrivo: ${cj["@odata.count"] ?? "?"}`);
    } else {
      console.log(`  ⚠️ conteggio non lette fallito: ${cj?.error?.message ?? cr.status}`);
    }
  }
}

main().catch((e) => console.error("Errore:", e));
