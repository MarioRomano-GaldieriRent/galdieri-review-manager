import { readFileSync } from "node:fs";
import path from "node:path";

// Utility escalation («In attesa»). SOLA LETTURA salvo «registra».
//   npm run esc list                 → elenca le escalation (attesa/pronta/chiusa)
//   npm run esc test <chiave>        → prova il recupero della risposta per una recensione
//   npm run esc registra <chiave>    → registra l'inoltro (backfill) di una recensione
//   npm run esc aggiorna             → cerca le risposte per tutte le «in attesa»

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
  const cmd = process.argv[2];
  const chiave = process.argv[3];
  const { activeMailbox } = await import("@/server/settings");
  const { leggiRecensione } = await import("@/server/db/recensioni");
  const {
    registraInoltro,
    elencoInAttesa,
    elencoPronte,
    leggiEscalation,
    rimuoviEscalation,
  } = await import("@/server/db/escalation");
  const { cercaRispostaPerRecensione, aggiornaAttese } = await import(
    "@/server/reviews/rispostaCustomerCare"
  );
  const mbx = await activeMailbox();

  if (cmd === "list") {
    const att = await elencoInAttesa();
    const pr = await elencoPronte();
    console.log(`In attesa (${att.length}):`);
    for (const e of att) console.log(`  • ${e.nomeCliente} · ${e.sedeNome} · ticket ${e.ticketId ?? "—"} · dal ${e.inoltrataIl.slice(0, 10)}`);
    console.log(`\nPronte (${pr.length}):`);
    for (const e of pr) console.log(`  • ${e.nomeCliente} · ${e.sedeNome} · risposta: ${(e.rispostaTesto || "").slice(0, 60)}…`);
    process.exit(0);
  }

  if (cmd === "test") {
    const r = chiave ? await leggiRecensione(chiave) : null;
    if (!r) { console.error("Recensione non trovata (passa la chiave)."); process.exit(1); }
    console.log(`Recensione: ${r.nome} · ${r.sede}\nCerco la risposta del customer care…\n`);
    const rep = await cercaRispostaPerRecensione({ originale: r.originale, idGoogle: r.idGoogle }, mbx);
    if (!rep) console.log("→ Nessuna risposta trovata (ancora).");
    else {
      console.log(`→ TROVATA (ticket ${rep.ticket ?? "—"}, del ${rep.quando}):`);
      console.log(rep.testo);
    }
    process.exit(0);
  }

  if (cmd === "registra") {
    const r = chiave ? await leggiRecensione(chiave) : null;
    if (!r) { console.error("Recensione non trovata (passa la chiave)."); process.exit(1); }
    await registraInoltro(r, { ticketId: null, operatoreId: 1 });
    console.log(`Registrata escalation per ${r.nome} · ${r.sede} (stato attesa).`);
    console.log(await leggiEscalation(r.chiave));
    process.exit(0);
  }

  if (cmd === "aggiorna") {
    const n = await aggiornaAttese(mbx);
    console.log(`Risposte trovate e salvate: ${n}`);
    process.exit(0);
  }

  if (cmd === "rimuovi") {
    if (!chiave) { console.error("Passa la chiave."); process.exit(1); }
    await rimuoviEscalation(chiave);
    console.log(`Rimossa escalation ${chiave}.`);
    process.exit(0);
  }

  console.error("Comandi: list | test <chiave> | registra <chiave> | aggiorna | rimuovi <chiave>");
  process.exit(1);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
