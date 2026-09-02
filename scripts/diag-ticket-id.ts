import { readFileSync } from "node:fs";
import path from "node:path";

// Ispezione di SOLA LETTURA di un ticket Freshdesk per ID, con la conversazione:
// stato, richiedente, agente, tag, campi, e ogni voce (risposta pubblica vs nota
// privata vs notifica in uscita). Serve a capire perché una mail non è arrivata.
//   npm run diag:ticketid -- 59332

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

const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (metodo !== "GET") throw new Error(`SCRITTURA BLOCCATA: ${metodo}`);
  return fetchVero(input, init);
}) as typeof fetch;

const STATO: Record<number, string> = { 2: "Aperto", 3: "In attesa", 4: "Risolto", 5: "Chiuso" };

function pulisci(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const id = process.argv.find((a) => /^\d+$/.test(a));
  if (!id) {
    console.error("Uso: npm run diag:ticketid -- <id>");
    process.exit(1);
  }
  const { resolveFreshdesk } = await import("@/server/settings");
  const cfg = await resolveFreshdesk();
  const dominio = cfg.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;
  const g = async (p: string) => {
    const r = await fetch(`https://${dominio}/api/v2${p}`, { headers: { Authorization: auth }, cache: "no-store" });
    if (!r.ok) throw new Error(`${p} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  const t = await g(`/tickets/${id}?include=requester`);
  console.log(`Ticket #${id}`);
  console.log(`  stato: ${STATO[t.status] ?? t.status} (${t.status})`);
  console.log(`  oggetto: ${t.subject}`);
  console.log(`  richiedente: ${t.requester?.name ?? "?"} <${t.requester?.email ?? "?"}>  (id ${t.requester_id})`);
  console.log(`  agente (responder_id): ${t.responder_id ?? "NESSUNO"}`);
  console.log(`  tag: [${(t.tags ?? []).join(", ") || "nessuno"}]`);
  console.log(`  cc: [${(t.cc_emails ?? []).join(", ") || "nessuno"}]`);
  console.log(`  campi: ${JSON.stringify(t.custom_fields ?? {})}`);
  console.log(`  creato: ${t.created_at} · aggiornato: ${t.updated_at}`);

  const conv = await g(`/tickets/${id}/conversations`);
  console.log(`\nConversazione (${conv.length} voci):`);
  for (const c of conv) {
    const tipo = c.private ? "NOTA PRIVATA" : c.incoming ? "IN ENTRATA" : "IN USCITA (notifica/risposta)";
    const to = (c.to_emails ?? []).join(", ");
    const testo = pulisci(c.body_text || c.body || "").slice(0, 120);
    console.log(`  • [${tipo}] ${c.created_at}${to ? ` → ${to}` : ""}`);
    console.log(`      ${testo}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
