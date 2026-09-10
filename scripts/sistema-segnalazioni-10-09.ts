import { readFileSync } from "node:fs";
import path from "node:path";

// Sistemazione mirata delle due segnalazioni del 10/9/2026 su cui i fatti sono
// certi (le altre tre — David, Del Ben, Barski — aspettano il Test su Google):
//
//  GAETANO CECCO (5★, Lancusi): Stefania ha risposto lei per email il 31/8
//    («Gentile signor Cecco…»), ticket risolto lo stesso giorno. È gestita alla
//    vecchia maniera → si chiude come «già gestita», con gli stessi tre passi
//    del tasto in Supervisione (segnalazione risolta, recensione gestita e
//    archiviata, escalation chiusa).
//
//  Cata. Bltn (1★, Bari Aeroporto): inoltrata a mano a Cherubina il 31/8,
//    ticket aperto, NESSUNA risposta ancora. È in lavorazione al customer care
//    → si registra l'escalation «in attesa» con la data VERA dell'inoltro, così
//    passa nel tab «In attesa», sparisce il tasto d'inoltro (che avrebbe aperto
//    un secondo ticket) e il ritorno di Cherubina verrà riconosciuto da solo.
//    La segnalazione va a «rimessa», NON «risolta»: una segnalazione risolta
//    terrebbe la recensione nascosta anche quando la risposta tornerà «pronta».
//    Il numero del ticket si cerca nelle pagine PIÙ VECCHIE di Freshdesk (7-8):
//    il ticket è del 31/8 ed è già fuori dalle 6 pagine che la home scarica.
//
//   npx tsx scripts/sistema-segnalazioni-10-09.ts            → PROVA (non scrive)
//   npx tsx scripts/sistema-segnalazioni-10-09.ts --scrivi   → applica

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

// Solo database: nessuna scrittura verso Freshdesk, Google o la posta.
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if ((init?.method ?? "GET").toUpperCase() !== "GET") throw new Error("SCRITTURA ESTERNA BLOCCATA");
  return fetchVero(i, init);
}) as typeof fetch;

const MARIO = 2;
const INOLTRO_CATA = new Date("2026-08-31T13:42:18.000Z"); // l'email «I:» di Stefania

async function main() {
  const scrivi = process.argv.includes("--scrivi");
  const { coll } = await import("@/server/db/connessione");
  const { leggiRecensione, segnaGestitaFuoriPortale } = await import("@/server/db/recensioni");
  const { chiudiSegnalazione, elencoAperte } = await import("@/server/db/segnalazioni");
  const { registraInoltro, segnaChiusa, leggiEscalation } = await import("@/server/db/escalation");
  const { listTickets, agganciaPerCorpo, STATO } = await import("@/server/integrations/freshdesk");

  const aperte = await elencoAperte();
  const cecco = aperte.find((s) => s.nomeCliente === "GAETANO CECCO");
  const cata = aperte.find((s) => s.nomeCliente === "Cata. Bltn");
  if (!cecco || !cata) throw new Error(`segnalazioni non trovate (cecco=${!!cecco}, cata=${!!cata})`);
  const rCata = await leggiRecensione(cata.chiave);
  if (!rCata) throw new Error("recensione Cata. Bltn non leggibile");

  // --- Cata. Bltn: il numero del ticket, nelle pagine vecchie -----------------
  let ticketCata: { id: number; status: number } | null = null;
  for (const page of [7, 8, 9]) {
    const { tickets, hasMore } = await listTickets({ page, perPage: 100, includi: ["description"] });
    const t = tickets.find(
      (tk) =>
        /bari/i.test(tk.subject) &&
        agganciaPerCorpo(tk.descriptionHtml, rCata.nome, rCata.originale).ok,
    );
    if (t) {
      ticketCata = { id: t.id, status: t.status };
      break;
    }
    if (!hasMore) break;
  }

  console.log("=== GAETANO CECCO ===");
  console.log(`  chiudo: segnalazione risolta + gestita/archiviata + escalation chiusa`);
  console.log("\n=== Cata. Bltn ===");
  console.log(
    `  ticket: ${ticketCata ? `#${ticketCata.id} · ${STATO[ticketCata.status] ?? ticketCata.status}` : "NON trovato (si registra senza numero)"}`,
  );
  console.log(`  registro escalation «attesa», inoltrata il ${INOLTRO_CATA.toISOString()}`);
  console.log(`  segnalazione -> «rimessa» (non risolta: deve poter tornare «pronta»)`);

  if (!scrivi) {
    console.log("\n[PROVA] Niente scritto. Rilancia con --scrivi.");
    process.exit(0);
  }

  // Cecco — gli stessi tre passi di chiudiGiaGestitaAction.
  const notaCecco =
    "Gestita alla vecchia maniera: Stefania ha risposto per email il 31/8 («Gentile signor Cecco, siamo lieti…»), " +
    "ticket risolto lo stesso giorno. Ricomparsa il 10/9 perché il ticket è uscito dalla finestra Freshdesk.";
  await chiudiSegnalazione(cecco.chiave, "risolta", notaCecco, MARIO);
  await segnaGestitaFuoriPortale(cecco.chiave, notaCecco);
  await segnaChiusa(cecco.chiave);

  // Cata. Bltn — in attesa del customer care, con la data vera.
  await registraInoltro(rCata, {
    ticketId: ticketCata?.id ?? null,
    operatoreId: MARIO,
    inoltrataIl: INOLTRO_CATA,
  });
  await chiudiSegnalazione(
    cata.chiave,
    "rimessa",
    "NON era da chiudere: inoltrata a mano a Cherubina il 31/8, nessuna risposta ancora. Registrata come escalation " +
      "«in attesa» con la data vera dell'inoltro: sta nel tab «In attesa», e quando Cherubina risponde torna «pronta» da sola.",
    MARIO,
  );

  console.log("\n=== DOPO ===");
  const rc = await leggiRecensione(cecco.chiave);
  console.log(`  Cecco: haRisposta=${rc?.haRisposta} archiviata=${rc?.archiviataIl ? "sì" : "no"}`);
  const e = await leggiEscalation(cata.chiave);
  console.log(`  Cata. Bltn: escalation stato=${e?.stato} ticket=${e?.ticketId ?? "—"} inoltrata=${e?.inoltrataIl}`);
  const restano = await elencoAperte();
  console.log(`  segnalazioni ancora aperte: ${restano.length} (${restano.map((s) => s.nomeCliente).join(", ")})`);
  void coll;
  process.exit(0);
}
main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
