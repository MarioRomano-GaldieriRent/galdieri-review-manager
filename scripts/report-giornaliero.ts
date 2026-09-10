import { readFileSync } from "node:fs";
import path from "node:path";

// Il report giornaliero agli admin: quante recensioni sono state gestite oggi
// dalle 9:00 alle 18:00, dal portale e dalla posta, con la spaccatura per
// punteggio (src/server/notifiche/reportGiornaliero.ts). Pensato per un cron
// (PM2 `cron_restart` o Task Scheduler di Windows) lanciato ogni giorno alle
// 18:00 — vedi ecosystem.config.js per l'esempio con PM2.
//
// SCRITTURA VERA: manda una mail e passa dal presidio scritturaConsentita()
// (in simulazione non scrive). Una guardia interna impedisce il doppio invio
// nello stesso giorno — un secondo lancio (un riavvio del cron, un errore di
// programmazione) trova il report già segnato «inviato» ed esce senza
// rimandare la mail.
//
//   npx tsx scripts/report-giornaliero.ts            → invia (una volta al giorno)
//   npx tsx scripts/report-giornaliero.ts --forza     → lo rimanda anche se oggi è già partito

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
  const forza = process.argv.includes("--forza");
  const { inviaReportGiornaliero, finestraOggi } = await import(
    "@/server/notifiche/reportGiornaliero"
  );
  const { modoOperativo } = await import("@/server/settings");

  const modo = await modoOperativo();
  const f = finestraOggi();
  console.log(`Modalità operativa: ${modo}${modo === "reale" ? "" : " → SIMULAZIONE, nessuna mail"}`);
  console.log(`Finestra: dalle ${f.dal.toLocaleString("it-IT", { timeZone: "Europe/Rome" })}`);
  console.log(`         alle  ${f.al.toLocaleString("it-IT", { timeZone: "Europe/Rome" })}`);

  const esito = await inviaReportGiornaliero({ forza });
  if (esito.inviata) {
    console.log(`✓ Report inviato a: ${esito.motivo}`);
    process.exit(0);
  }
  console.log(`Non inviato: ${esito.motivo}`);
  // Un mancato invio per guardia (già spedito oggi) o per modalità simulazione
  // non è un guasto: exit 0. Solo un vero errore (Graph giù, config mancante)
  // deve far apparire lo script come fallito agli occhi dello scheduler.
  const benigno = /già inviato oggi|simulazione|non configurato/i.test(esito.motivo);
  process.exit(benigno ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
