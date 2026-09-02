import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA: per una lista di ticket id, stampa oggetto, stato e la riga
// «Nome:» del corpo — per capire a quale recensione appartengono.
//   npm run diag:corpi -- 58882 58880 58819 58818 58817 58779

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

function piatto(html: string): string {
  return (html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  if (ids.length === 0) {
    console.error("Uso: npm run diag:corpi -- <id> <id> ...");
    process.exit(1);
  }
  const { getTicket } = await import("@/server/integrations/freshdesk");
  for (const id of ids) {
    try {
      const t = await getTicket(id);
      const corpo = piatto(t.descriptionHtml);
      const nome = corpo.match(/nome:\s*([^,]+?)(?:\s+commento:|\s+punteggio:|$)/i);
      console.log(`#${id}  ${(STATO[t.status] ?? t.status).padEnd(9)}  oggetto: ${t.subject}`);
      console.log(`     Nome nel corpo: ${nome ? nome[1].trim() : "—"}`);
      console.log(`     estratto: ${corpo.slice(0, 130)}`);
    } catch (e) {
      console.log(`#${id}  ERRORE: ${e instanceof Error ? e.message : e}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
