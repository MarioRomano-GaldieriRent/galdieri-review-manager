import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA: dice se un'email è un AGENTE Freshdesk (gli agenti non ricevono
// le notifiche "cliente", es. ticket risolto/chiuso).
//   npm run diag:agente -- stefania.maffeo@galdierirent.it

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

async function main() {
  const email = process.argv.find((a) => a.includes("@"));
  if (!email) {
    console.error("Uso: npm run diag:agente -- <email>");
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

  const agenti = await g(`/agents?email=${encodeURIComponent(email)}`);
  if (Array.isArray(agenti) && agenti.length > 0) {
    const a = agenti[0];
    console.log(`«${email}» È UN AGENTE Freshdesk.`);
    console.log(`  id ${a.id} · ${a.contact?.name ?? "?"} · attivo: ${a.available ?? "?"} · ruolo: ${(a.role_ids ?? []).join(",")}`);
    console.log(`  → Freshdesk NON gli invia le notifiche 'richiedente' (ticket creato/risolto/chiuso).`);
  } else {
    console.log(`«${email}» NON risulta agente (è un contatto/cliente): riceverebbe le notifiche richiedente.`);
    const contatti = await g(`/contacts?email=${encodeURIComponent(email)}`);
    if (Array.isArray(contatti) && contatti.length > 0) {
      console.log(`  Contatto id ${contatti[0].id} · ${contatti[0].name}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
