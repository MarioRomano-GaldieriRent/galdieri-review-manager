import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA: prende dalla casella la prima mail che contiene il termine e ci
// prova l'estrazione della risposta del customer care (estraiRisposta).
//   npm run diag:risposta -- stefania.maffeo@galdierirent.it "colleagues in Catania offered"

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
  const mailbox = process.argv.find((a) => a.includes("@"));
  const termine = process.argv.slice(2).find((a) => !a.includes("@"));
  if (!mailbox || !termine) {
    console.error('Uso: npm run diag:risposta -- <casella@> "<termine>"');
    process.exit(1);
  }
  const { listInbox, getMessage } = await import("@/server/graph/client");
  const { htmlToText } = await import("@/server/reviews/parse");
  const { estraiRisposta } = await import("@/server/reviews/rispostaCustomerCare");

  const res = await listInbox({ mailbox, search: termine, top: 3 });
  const rep = res.messages.find((m) => m.fromAddress.toLowerCase().includes("customer.care")) ?? res.messages[0];
  if (!rep) {
    console.log("Nessun messaggio.");
    process.exit(0);
  }
  console.log(`Oggetto: ${rep.subject}\nDa: ${rep.fromAddress}\n`);
  const full = await getMessage(rep.id, mailbox);
  const testo = full.bodyIsHtml ? htmlToText(full.bodyContent) : full.bodyContent;
  const est = estraiRisposta(testo);
  console.log("===== RISPOSTA ESTRATTA =====");
  if (!est) {
    console.log("(non riconosciuta)");
  } else {
    console.log(`ticket: ${est.ticket ?? "—"}`);
    console.log(`testo:\n${est.testo}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
