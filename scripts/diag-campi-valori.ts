import { readFileSync } from "node:fs";
import path from "node:path";

// Elenca le OPZIONI ammesse dei ticket field di Freshdesk che ci servono per
// chiudere un ticket-recensione (tipo, specifica_1 = positiva/negativa,
// specifica_2 = N stelle, tipo_di_richiesta). SOLA LETTURA.
//   npm run diag:valori

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
  if (metodo !== "GET") throw new Error("SCRITTURA BLOCCATA");
  return fetchVero(input, init);
}) as typeof fetch;

function mostraScelte(nome: string, choices: unknown): void {
  console.log(`\n▸ ${nome}`);
  if (Array.isArray(choices)) {
    for (const c of choices) console.log(`    ${JSON.stringify(c)}`);
  } else if (choices && typeof choices === "object") {
    for (const [k, v] of Object.entries(choices as Record<string, unknown>)) {
      console.log(`    ${JSON.stringify(k)}  →  ${JSON.stringify(v)}`);
    }
  } else {
    console.log(`    (nessuna scelta: ${JSON.stringify(choices)})`);
  }
}

async function main() {
  const { resolveFreshdesk } = await import("@/server/settings");
  const cfg = await resolveFreshdesk();
  if (!cfg.domain || !cfg.apiKey) {
    console.log("Freshdesk non configurato.");
    process.exit(1);
  }
  const dominio = cfg.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${cfg.apiKey}:X`).toString("base64")}`;

  const res = await fetch(`https://${dominio}/api/v2/ticket_fields`, {
    headers: { Authorization: auth, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    console.log(`Errore ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const campi = (await res.json()) as {
    name: string;
    label?: string;
    type?: string;
    choices?: unknown;
  }[];

  const cerca = /type|specifica|tipo_di_richiesta|recension|stell/i;
  for (const c of campi) {
    if (c.name === "type" || cerca.test(c.name) || (c.label && cerca.test(c.label))) {
      console.log(`\n═══ ${c.name}  (label: ${c.label ?? "—"} · type: ${c.type ?? "—"})`);
      mostraScelte(c.name, c.choices);
    }
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
