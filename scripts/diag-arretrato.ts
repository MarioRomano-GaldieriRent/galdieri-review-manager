import { readFileSync } from "node:fs";
import path from "node:path";

// Quante recensioni "da approvare" emergerebbero pescando dall'ARCHIVIO (Mongo)
// invece che dalle sole ultime 50 email? SOLA LETTURA.
//   npm run diag:arretrato

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

async function main() {
  const { coll } = await import("@/server/db/connessione");
  const { chiaviPubblicate } = await import("@/server/db/pubblicazioni");

  const rec = await coll("recensioni");
  const totale = await rec.countDocuments({});

  // Candidate "da approvare" secondo i flag persistiti: 5★ senza testo, non
  // risposta, non archiviata. (Il filtro "pubblicate" sta in un'altra collezione.)
  const filtro5senzaTesto = { stelle: 5, haTesto: false, archiviata: false, haRisposta: false };
  const cinque = await rec.countDocuments(filtro5senzaTesto);
  const cinqueRisolte = await rec.countDocuments({ ...filtro5senzaTesto, risolto: true });

  // Tolgo quelle già pubblicate da noi.
  const pubblicate = await chiaviPubblicate().catch(() => new Set<string>());
  const candidate = (await rec
    .find(filtro5senzaTesto, { projection: { _id: 1, nomeCliente: 1, ricevutaIl: 1 } })
    .sort({ ricevutaIl: -1 })
    .toArray()) as { _id: string; nomeCliente: string; ricevutaIl: Date }[];
  const daApprovare = candidate.filter((c) => !pubblicate.has(c._id));

  console.log(`Recensioni in archivio (Mongo): ${totale}`);
  console.log(`5★ senza testo · non risposta · non archiviata: ${cinque}`);
  console.log(`   di cui col ticket «risolto»: ${cinqueRisolte}`);
  console.log(`Già pubblicate da noi (tolte): ${cinque - daApprovare.length}`);
  console.log(`\n→ «Da approvare» pescando dal DB mostrerebbe: ${daApprovare.length} recensioni.\n`);

  console.log("Le più recenti (max 15):");
  for (const c of daApprovare.slice(0, 15)) {
    const d = new Date(c.ricevutaIl).toISOString().slice(0, 10);
    console.log(`  ${d}  ${c.nomeCliente}`);
  }
  const arthur = daApprovare.find((c) => /arthur|lavall/i.test(c.nomeCliente));
  console.log(
    `\nArthur nell'archivio? ${arthur ? `SÌ (${new Date(arthur.ricevutaIl).toISOString().slice(0, 10)})` : "no"}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
