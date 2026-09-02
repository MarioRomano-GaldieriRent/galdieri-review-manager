import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA: ispeziona la cartella «Posta inviata» della casella e mostra, per
// gli ultimi inoltri, DESTINATARI e COPIA CONOSCENZA reali — per verificare se
// l'inoltro del software includeva davvero customer.care in CC.
//   npm run diag:inviata            (ultimi 20)
//   npm run diag:inviata -- olbia   (filtra oggetto)

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

type Rec = { emailAddress?: { address?: string } };

async function main() {
  const filtro = (process.argv[2] || "").toLowerCase();
  const { resolveGraph, activeMailbox } = await import("@/server/settings");
  const cfg = await resolveGraph();
  const mbx = await activeMailbox();

  // Token app-only
  const tk = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const tj = (await tk.json()) as { access_token?: string; error_description?: string };
  if (!tj.access_token) throw new Error(`token: ${tj.error_description}`);

  const url =
    `${cfg.graphUrl}/users/${encodeURIComponent(mbx)}/mailFolders/SentItems/messages` +
    `?$top=25&$orderby=sentDateTime desc&$select=subject,sentDateTime,toRecipients,ccRecipients`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tj.access_token}` }, cache: "no-store" });
  const j = (await r.json()) as {
    value?: { subject?: string; sentDateTime?: string; toRecipients?: Rec[]; ccRecipients?: Rec[] }[];
    error?: { message?: string };
  };
  if (!r.ok) throw new Error(`Graph ${r.status}: ${j.error?.message}`);

  const indir = (l?: Rec[]) => (l ?? []).map((x) => x.emailAddress?.address).filter(Boolean).join(", ") || "—";
  console.log(`Posta inviata di ${mbx}${filtro ? ` (oggetto ~ «${filtro}»)` : ""}:\n`);
  for (const m of j.value ?? []) {
    if (filtro && !(m.subject ?? "").toLowerCase().includes(filtro)) continue;
    console.log(`• ${m.sentDateTime}  ${m.subject}`);
    console.log(`    A:  ${indir(m.toRecipients)}`);
    console.log(`    CC: ${indir(m.ccRecipients)}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
