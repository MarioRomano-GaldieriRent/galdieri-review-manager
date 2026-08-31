import { readFileSync } from "node:fs";
import path from "node:path";

// Riallinea SOLO lo schema di MongoDB (validator, indici, viste) a quello
// dichiarato in src/server/db/schema.ts, senza semina né travaso.
//
// Di norma NON serve: applicaSchema() gira da sola al primo avvio dell'app
// (src/server/db/avvio.ts). Ma quell'avvio è memorizzato una volta per processo,
// quindi se cambi lo schema mentre il server è già in piedi (es. dev con Fast
// Refresh) il validator resta quello vecchio e le scritture del campo nuovo
// vengono rifiutate ("Document failed validation"). Questo script lo aggiorna
// a server acceso, senza doverlo riavviare. È idempotente.
//
//   npm run db:schema

function caricaEnv() {
  try {
    const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const riga of txt.split(/\r?\n/)) {
      const m = riga.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* senza .env si prosegue */
  }
}
caricaEnv();

async function main() {
  const { db, mongo } = await import("../src/server/db/connessione");
  const { applicaSchema } = await import("../src/server/db/schema");

  const d = await db();
  console.log("Riallineo lo schema (validator, indici, viste)…");
  await applicaSchema(d);
  console.log("Schema allineato.");

  const client = await mongo();
  await client.close();
  console.log("fatto.\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
