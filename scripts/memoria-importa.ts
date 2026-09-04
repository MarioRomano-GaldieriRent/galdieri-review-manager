import { readFileSync } from "node:fs";
import path from "node:path";

// Importa (o riallinea) la MEMORIA dalla Posta inviata di Stefania.
//   npm run memoria:importa               → ultimi 12 mesi
//   npm run memoria:importa -- 6          → ultimi 6 mesi
//   npm run memoria:importa -- 12 --azzera → PRIMA svuota gli esempi (perde le
//                                            scelte del pannello: solo per rifare
//                                            da zero una prima importazione)
// Idempotente: le voci già presenti si riallineano senza toccare le scelte
// fatte nel pannello (incluso/escluso/eliminata). Scrive SOLO su memoria_esempi.

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const taglia = (s: string, n: number) =>
  (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

async function main() {
  const argomenti = process.argv.slice(2);
  const mesi = Number(argomenti.find((a) => /^\d+$/.test(a))) || 12;
  const { importaMemoria } = await import("@/server/memoria/importa");

  if (argomenti.includes("--azzera")) {
    const { azzeraEsempi } = await import("@/server/db/memoria");
    const n = await azzeraEsempi();
    console.log(`Azzerati ${n} esempi (i blocchi di contesto restano).`);
  }

  const t0 = Date.now();
  const e = await importaMemoria(mesi, (r) => console.log(r));
  const sec = Math.round((Date.now() - t0) / 1000);

  console.log(
    `\n================ MEMORIA · importazione ultimi ${e.mesi} mesi (${sec}s) ================`,
  );
  console.log(
    `Posta inviata: ${e.pagine} pagine, ${e.emailLette} email lette, ${e.emailRecensione} sulle recensioni`,
  );
  console.log(
    `  saltate: ${e.inoltriSaltati} inoltri (I:), ${e.altriSaltati} altro, ${e.senzaTesto} senza testo`,
  );
  console.log(
    `Recensione ricostruita: ${e.dallaCitazione} dalla citazione, ${e.dallArchivio} dall'archivio, ${e.senzaRecensione} non trovata`,
  );
  console.log(
    `Col testo del customer care (escluse): ${e.daCustomerCare} · di cui verificate in conversazione: ${e.controllateCustomerCare} negative/neutre`,
  );
  console.log(`Salvate: ${e.nuove} nuove, ${e.aggiornate} riallineate\n`);
  console.log("--- per tipo ---");
  for (const [k, n] of Object.entries(e.perTipo)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log("--- per lingua della risposta ---");
  for (const [k, n] of Object.entries(e.perLingua)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log("\n--- un campione per gruppo ---");
  for (const c of e.campioni) {
    console.log(`\n[${c.tipo} · ${c.lingua} · ${c.stelle ?? "—"}★] ${c.nome}`);
    if (c.commento) console.log(`  recensione: ${taglia(c.commento, 160)}`);
    console.log(`  risposta:   ${taglia(c.risposta, 220)}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
