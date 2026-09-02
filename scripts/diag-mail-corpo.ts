import { readFileSync } from "node:fs";
import path from "node:path";

// SOLA LETTURA: cerca nella Posta in arrivo e stampa il CORPO COMPLETO (testo)
// del primo messaggio che contiene il termine. Serve a capire la struttura di
// una risposta del customer care.
//   npm run diag:mailcorpo -- stefania.maffeo@galdierirent.it "ticket 58595"

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
    console.error('Uso: npm run diag:mailcorpo -- <casella@> "<termine>"');
    process.exit(1);
  }
  const { listInbox, getMessage } = await import("@/server/graph/client");
  const { htmlToText } = await import("@/server/reviews/parse");

  const res = await listInbox({ mailbox, search: termine, top: 3 });
  if (res.messages.length === 0) {
    console.log("Nessun messaggio.");
    process.exit(0);
  }
  const m = res.messages[0];
  console.log(`Oggetto: ${m.subject}\nDa: ${m.fromName} <${m.fromAddress}>\nData: ${m.receivedDateTime}\n`);
  const full = await getMessage(m.id, mailbox);
  const testo = full.bodyIsHtml ? htmlToText(full.bodyContent) : full.bodyContent;
  console.log("===== CORPO (testo) =====");
  console.log(testo.slice(0, 2500));
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
