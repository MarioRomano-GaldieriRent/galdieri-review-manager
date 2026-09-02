import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA: i ticket Freshdesk PIÙ RECENTI per data di creazione, con orario,
// oggetto e nome nel corpo. Serve a vedere se un ticket è appena nato.
//   npm run diag:ultimi            (ultimi ~30)
//   npm run diag:ultimi -- olbia   (filtra l'oggetto)

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

async function main() {
  const filtro = (process.argv[2] || "").toLowerCase();
  const { resolveFreshdesk } = await import("@/server/settings");
  const { getTicket } = await import("@/server/integrations/freshdesk");
  const cfg = await resolveFreshdesk();
  const dominio = cfg.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;

  const r = await fetch(
    `https://${dominio}/api/v2/tickets?order_by=created_at&order_type=desc&per_page=100&page=1`,
    { headers: { Authorization: auth }, cache: "no-store" },
  );
  if (!r.ok) {
    console.error(`Freshdesk ${r.status}: elenco non disponibile (magari rate-limit).`);
    process.exit(1);
  }
  const tickets = (await r.json()) as { id: number; status: number; subject: string; created_at: string }[];
  const scelti = tickets
    .filter((t) => !filtro || t.subject.toLowerCase().includes(filtro))
    .slice(0, 30);

  console.log(`Ticket più recenti${filtro ? ` (oggetto ~ «${filtro}»)` : ""}:\n`);
  for (const t of scelti) {
    let nome = "";
    try {
      const full = await getTicket(t.id);
      const corpo = (full.descriptionHtml || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const m = corpo.match(/nome:\s*([^,]+?)(?:\s+commento:|\s+punteggio:|$)/i);
      nome = m ? m[1].trim().slice(0, 30) : "";
    } catch {
      nome = "(corpo non letto)";
    }
    console.log(`  #${t.id}  ${t.created_at}  ${(STATO[t.status] ?? t.status).toString().padEnd(8)}  ${t.subject.slice(0, 46)}  · ${nome}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
