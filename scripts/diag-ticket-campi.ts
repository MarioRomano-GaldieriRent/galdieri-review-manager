import { readFileSync } from "node:fs";
import path from "node:path";

// Dump GREZZO di uno o più ticket Freshdesk: tipo, sorgente, tag, priorità,
// stato e TUTTI i custom_fields. SOLA LETTURA (solo GET). Serve a confrontare un
// ticket "buono" con uno a cui mancano dei campi (stelle, «Recensione Google»…).
//   npm run diag:campi -- 59270 59266 59122

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
  const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (metodo !== "GET") throw new Error(`SCRITTURA BLOCCATA: ${metodo} ${url}`);
  return fetchVero(input, init);
}) as typeof fetch;

async function main() {
  const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    console.log("Uso: npm run diag:campi -- <id> [id2] [id3]");
    process.exit(1);
  }

  const { resolveFreshdesk } = await import("@/server/settings");
  const cfg = await resolveFreshdesk();
  if (!cfg.domain || !cfg.apiKey) {
    console.log("Freshdesk non configurato.");
    process.exit(1);
  }
  const dominio = cfg.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;

  for (const id of ids) {
    const res = await fetch(`https://${dominio}/api/v2/tickets/${id}`, {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      console.log(`\n#${id}: errore ${res.status}`);
      continue;
    }
    const t = (await res.json()) as Record<string, unknown>;
    console.log("\n" + "═".repeat(64));
    console.log(`Ticket #${id}`);
    console.log(`  subject:      ${t.subject}`);
    console.log(`  status:       ${t.status}`);
    console.log(`  priority:     ${t.priority}`);
    console.log(`  type:         ${JSON.stringify(t.type)}`);
    console.log(`  source:       ${t.source}`);
    console.log(`  responder_id: ${t.responder_id}`);
    console.log(`  group_id:     ${t.group_id}`);
    console.log(`  product_id:   ${t.product_id}`);
    console.log(`  tags:         ${JSON.stringify(t.tags)}`);
    const cf = (t.custom_fields ?? {}) as Record<string, unknown>;
    const chiavi = Object.keys(cf);
    console.log(`  custom_fields (${chiavi.length}):`);
    if (chiavi.length === 0) console.log("    (nessuno)");
    for (const k of chiavi) console.log(`    ${k.padEnd(28)} = ${JSON.stringify(cf[k])}`);
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
