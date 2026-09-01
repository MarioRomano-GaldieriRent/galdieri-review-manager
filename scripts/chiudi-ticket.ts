import { readFileSync } from "node:fs";
import path from "node:path";

// Chiude UN ticket su Freshdesk (stato Risolto + tag sede + nota privata), con
// la stessa funzione dell'app (chiudiTicketPubblicato). SCRITTURA: passa dal
// presidio scritturaConsentita() → scrive solo in modalità REALE, altrimenti
// simula e non tocca niente. Uso mirato, l'id va passato a mano:
//
//   npm run chiudi:ticket -- 59270 5 "Grazie."   (id, stelle, [risposta])
//
// Verifica il ticket prima di scrivere. Se è già Risolto/Chiuso non lo richiude:
// applica solo la classificazione mancante (tipo, tag, stelle).

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
  const id = Number(process.argv[2]);
  const stelle = process.argv[3] != null && process.argv[3] !== "" ? Number(process.argv[3]) : null;
  const risposta = (process.argv[4] || "Grazie.").trim();
  const operatore = process.argv[5] || "Mario Romano";
  if (!Number.isInteger(id) || id <= 0) {
    console.log('Uso: npm run chiudi:ticket -- <id> <stelle> ["testo risposta"] ["operatore"]');
    process.exit(1);
  }

  const { getTicket, STATO, ticketUrl, isFreshdeskConfigured } = await import(
    "@/server/integrations/freshdesk"
  );
  const { chiudiTicketPubblicato, applicaClassificazioneRecensione, testoNotaPubblicazione } =
    await import("@/server/integrations/freshdeskChiusura");
  const { tagSede } = await import("@/server/automation/sedi");
  const { modoOperativo } = await import("@/server/settings");

  if (!(await isFreshdeskConfigured())) {
    console.log("Freshdesk non configurato.");
    process.exit(1);
  }

  const modo = await modoOperativo();
  console.log(`Modalità operativa: ${modo}${modo === "reale" ? "" : " → SOLO SIMULATA, niente scrittura"}`);

  const t = await getTicket(id);
  console.log(`\nTicket #${t.id}`);
  console.log(`  oggetto: ${t.subject}`);
  console.log(`  stato:   ${STATO[t.status] ?? t.status}`);
  console.log(`  stelle:  ${stelle ?? "(non date)"}`);
  console.log(`  link:    ${await ticketUrl(t.id)}\n`);

  // Il tag della sede si ricava dall'oggetto (…GOOGLE <sede>).
  const sede = t.subject.replace(/^.*RECENSIONE\s+GOOGLE\s+/i, "").trim();
  const tag = tagSede(sede);

  // Se è già Risolto/Chiuso: NON lo richiudo (né rifaccio la nota) — applico solo
  // la classificazione mancante (tipo, tag, stelle). Altrimenti chiusura piena.
  const giaChiuso = t.status === 4 || t.status === 5;
  let esito;
  if (giaChiuso) {
    console.log(`Già Risolto/Chiuso: applico solo la classificazione (tipo «Recensioni clienti GMB», tag «${tag}»+«personale», ${stelle ?? "?"} stelle)…`);
    esito = await applicaClassificazioneRecensione(t.id, { tagSede: tag, stelle });
  } else {
    const nota = testoNotaPubblicazione(operatore, new Date(), risposta);
    console.log(`Chiudo (Risolto + classificazione) e aggiungo la nota privata…`);
    esito = await chiudiTicketPubblicato(t.id, { tagSede: tag, nota, stelle });
  }

  console.log(`\n→ Esito: ${esito.stato}`);
  if (esito.stato === "eseguita") console.log(`   ${esito.descrizione}`);
  else if (esito.stato === "simulata") {
    console.log(`   ${esito.descrizione}`);
    console.log("   (Nessuna scrittura: sei in simulazione. Passa a modalità reale per scrivere davvero.)");
  } else console.log(`   ERRORE: ${esito.errore}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
