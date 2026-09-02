import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA: elenca i ticket-recensione recenti col loro STATO finale, per
// capire se «normalmente» finiscono Risolto (4) o Chiuso (5).
//   npm run diag:recticket

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
  const { resolveFreshdesk } = await import("@/server/settings");
  const cfg = await resolveFreshdesk();
  const dominio = cfg.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;

  const trovati: { id: number; status: number; subject: string; updated: string }[] = [];
  for (let pagina = 1; pagina <= 6 && trovati.length < 20; pagina++) {
    const r = await fetch(
      `https://${dominio}/api/v2/tickets?order_by=updated_at&order_type=desc&per_page=100&page=${pagina}`,
      { headers: { Authorization: auth }, cache: "no-store" },
    );
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    const pag = (await r.json()) as { id: number; status: number; subject: string; updated_at: string }[];
    if (pag.length === 0) break;
    for (const t of pag) {
      if (/recensione google/i.test(t.subject)) {
        trovati.push({ id: t.id, status: t.status, subject: t.subject, updated: t.updated_at });
      }
    }
  }

  console.log(`Ticket-recensione recenti trovati: ${trovati.length}\n`);
  const conteggio: Record<string, number> = {};
  for (const t of trovati) {
    const s = STATO[t.status] ?? String(t.status);
    conteggio[s] = (conteggio[s] ?? 0) + 1;
    console.log(`  #${t.id}  ${s.padEnd(9)} ${t.updated.slice(0, 10)}  ${t.subject.slice(0, 50)}`);
  }
  console.log("\nRiepilogo stati:", JSON.stringify(conteggio));
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
