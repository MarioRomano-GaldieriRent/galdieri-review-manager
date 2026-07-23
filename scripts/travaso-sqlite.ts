import { readFileSync } from "node:fs";
import path from "node:path";

// Travaso una tantum da SQLite (data/galdieri.db) a MongoDB.
//
// Di norma NON serve lanciarlo: parte da solo al primo avvio dell'app (vedi
// src/server/db/avvio.ts). Questo script fa la stessa cosa a server fermo, ed è
// utile per eseguire e verificare la migrazione senza avviare Next.
//
//   npm run travaso                 esegue il travaso (idempotente)
//   npm run travaso -- --riepilogo  stampa solo cosa c'è già in MongoDB

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
  const soloRiepilogo = process.argv.includes("--riepilogo");
  const { db, mongo } = await import("../src/server/db/connessione");
  const { applicaSchema } = await import("../src/server/db/schema");
  const { semina } = await import("../src/server/db/seed");
  const { travasaTutto, riepilogoTravasi } = await import("../src/server/db/travaso");

  const d = await db();

  if (!soloRiepilogo) {
    console.log("Applico schema e semina…");
    await applicaSchema(d);
    await semina(d);
    console.log("Travaso da data/galdieri.db…");
    await travasaTutto(d);
  }

  const r = await riepilogoTravasi(d);
  console.log("\nIn MongoDB adesso:");
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(14)} ${v}`);

  const client = await mongo();
  await client.close();
  console.log("\nfatto.\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
