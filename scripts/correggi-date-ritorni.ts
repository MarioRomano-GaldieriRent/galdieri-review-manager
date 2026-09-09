import { readFileSync } from "node:fs";
import path from "node:path";

// Rimette la data di arrivo giusta alle recensioni «riscoperte» dalla risposta
// del customer care.
//
// Il problema. L'ingest legge una finestra di posta recente. Una recensione di
// metà agosto è fuori da quella finestra e il portale non la conosce; poi, a
// settembre, Cherubina risponde all'inoltro e il thread torna a farsi vedere.
// A quel punto il portale la schedula — ma con la data del messaggio più
// vecchio fra QUELLI CHE VEDE, cioè la risposta. Silvia Endrizzi è del 25
// agosto e risultava del 7 settembre.
//
// Sbaglia due cose insieme: sullo schermo la recensione sembra nuova (ed è per
// questo che vengono segnalate come «già fatto»), e nelle statistiche cade
// nella coorte del mese sbagliato — gestionePerStelle conta per data di
// RICEZIONE. Anche la coda «ultimi 30 giorni» ne risente: una recensione
// datata oggi ci resta un mese in più del dovuto.
//
// La data vera c'è: getConversation restituisce il thread INTERO, email
// originale compresa. Si prende il messaggio più vecchio.
//
// Da qui in avanti la correzione la fa da sé registraRitorniCustomerCare, alla
// prima registrazione di ogni ritorno. Questo script serve per quelle già
// registrate prima che ci fosse.
//
//   npx tsx scripts/correggi-date-ritorni.ts            → PROVA (non scrive)
//   npx tsx scripts/correggi-date-ritorni.ts --scrivi   → corregge davvero
//
// La correzione può solo spostare la data INDIETRO (correggiDataArrivo usa
// $min): rilanciarlo non fa danni e non può inventare una data futura.

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const it = (d: Date) => d.toLocaleString("it-IT", { timeZone: "Europe/Rome" });

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { coll } = await import("@/server/db/connessione");
  const { correggiDataArrivo } = await import("@/server/db/recensioni");
  const { getConversation } = await import("@/server/graph/client");
  const { activeMailbox } = await import("@/server/settings");
  const mailbox = await activeMailbox();

  // Le recensioni entrate per questa strada: la voce escalation l'ha scritta il
  // sistema (operatoreId 1) ricostruendo un inoltro fatto a mano in Outlook.
  const voci = (await (await coll("escalation")).find({ operatoreId: 1 }).toArray()) as {
    _id: string;
  }[];
  console.log(`Ritorni del customer care ricostruiti dal sistema: ${voci.length}\n`);

  let daCorreggere = 0;
  let corrette = 0;
  for (const v of voci) {
    const d = (await (await coll("recensioni")).findOne({ _id: v._id })) as {
      nomeCliente?: string;
      stelle?: number | null;
      ricevutaIl?: Date;
      conversazioneId?: string;
    } | null;
    if (!d?.ricevutaIl) continue;

    let prima: Date | null = null;
    try {
      const messaggi = await getConversation(d.conversazioneId ?? v._id, mailbox);
      if (messaggi.length > 0) {
        prima = new Date(Math.min(...messaggi.map((m) => new Date(m.receivedDateTime).getTime())));
      }
    } catch (e) {
      console.log(`  ! «${d.nomeCliente}» thread non leggibile: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!prima || Number.isNaN(prima.getTime())) continue;

    const scartoGiorni = Math.round((d.ricevutaIl.getTime() - prima.getTime()) / 86_400_000);
    if (scartoGiorni < 1) continue;

    daCorreggere++;
    console.log(`  «${d.nomeCliente}» ${d.stelle}★`);
    console.log(`      ${it(d.ricevutaIl)}  ->  ${it(prima)}   (${scartoGiorni} giorni indietro)`);
    if (scrivi && (await correggiDataArrivo(v._id, prima))) corrette++;
  }

  console.log(
    scrivi
      ? `\nCorrette: ${corrette} su ${daCorreggere}.`
      : `\n[PROVA] Da correggere: ${daCorreggere}. Niente è stato scritto — rilancia con --scrivi.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
