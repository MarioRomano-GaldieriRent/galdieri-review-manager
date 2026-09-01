import { readFileSync } from "node:fs";
import path from "node:path";

// Controlla lo STATO su Freshdesk del ticket nato da una recensione. SOLA
// LETTURA: freshdesk.ts fa solo GET, e una guardia blocca comunque ogni
// scrittura via fetch. Elenca TUTTI i ticket con lo stesso oggetto creati dopo
// la recensione, e ci cerca il nome ignorando accenti/entità HTML (il match
// "stretto" di cercaTicketPerRecensione fallisce sui nomi accentati).
//   npm run diag:ticket -- "arthur"      (default: "arthur")

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

// Guardia sola-lettura: ogni scrittura via fetch è vietata.
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (metodo !== "GET") throw new Error(`SCRITTURA BLOCCATA: ${metodo} ${url}`);
  return fetchVero(input, init);
}) as typeof fetch;

/** minuscolo, senza accenti, entità HTML decodificate, tag via, spazi compressi. */
function piatto(s: string): string {
  return (s || "")
    .replace(/&eacute;|&#233;/gi, "e")
    .replace(/&agrave;|&#224;/gi, "a")
    .replace(/&egrave;|&#232;/gi, "e")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // toglie i segni diacritici
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normOgg(s: string): string {
  return (s || "")
    .replace(/^\s*((r|re|i|fw|fwd|rif)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function main() {
  const cerca = (process.argv.slice(2).join(" ").trim() || "arthur").toLowerCase();

  const { coll } = await import("@/server/db/connessione");
  const { listTickets, getTicket, ticketUrl, STATO, isFreshdeskConfigured, cercaTicketPerRecensione } =
    await import("@/server/integrations/freshdesk");

  if (!(await isFreshdeskConfigured())) {
    console.log("Freshdesk non è configurato (dominio o API key mancanti).");
    process.exit(1);
  }

  const rec = await coll("recensioni");
  const doc = (await rec.findOne({ nomeCliente: { $regex: cerca, $options: "i" } })) as
    | { _id: string; nomeCliente: string; oggetto: string; ricevutaIl: Date; sede?: { nome?: string } }
    | null;
  if (!doc) {
    console.log(`Nessuna recensione in archivio con nome che contiene «${cerca}».`);
    process.exit(0);
  }

  console.log(`Recensione: «${doc.nomeCliente}» · sede: ${doc.sede?.nome ?? "—"}`);
  console.log(`  oggetto: ${doc.oggetto} · arrivata: ${new Date(doc.ricevutaIl).toISOString()}\n`);

  const atteso = normOgg(doc.oggetto);
  const soglia = new Date(doc.ricevutaIl).getTime() - 5 * 60 * 1000;

  // Scorro i ticket recenti e tengo quelli con lo stesso oggetto nati dopo la recensione.
  const candidati: { id: number; status: number; createdAt: string; updatedAt: string }[] = [];
  for (let page = 1; page <= 6; page++) {
    const { tickets, hasMore } = await listTickets({ page, perPage: 100 });
    for (const t of tickets) {
      if (normOgg(t.subject) !== atteso) continue;
      if (new Date(t.createdAt).getTime() < soglia) continue;
      candidati.push({ id: t.id, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt });
    }
    if (!hasMore) break;
  }

  console.log(`Ticket con oggetto «${doc.oggetto}» creati dopo la recensione: ${candidati.length}\n`);
  if (candidati.length === 0) {
    console.log("→ Nessun ticket collegato a questa recensione. Dal nostro lato NON è stato chiuso da noi.");
    process.exit(0);
  }

  const nomePiatto = piatto(doc.nomeCliente);
  // Parole del nome (≥3 lettere) per fiutare il ticket giusto nel corpo.
  const parole = nomePiatto.split(" ").filter((w) => w.length >= 3);
  let trovato: { id: number; status: number; corpo: string } | null = null;

  for (const c of candidati.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )) {
    const t = await getTicket(c.id);
    const corpo = piatto(t.descriptionHtml);
    const match = parole.some((p) => corpo.includes(p));
    const stato = STATO[t.status] ?? `stato ${t.status}`;
    const chiuso = t.status === 4 || t.status === 5;
    console.log(
      `  #${t.id}  ${stato.padEnd(10)} ${chiuso ? "(chiuso/risolto)" : "(aperto)"}  creato ${t.createdAt.slice(0, 10)}  ${match ? "⟵ CONTIENE il nome" : ""}`,
    );
    if (match && !trovato) trovato = { id: t.id, status: t.status, corpo };
  }

  // Come appare il nome nel corpo del ticket trovato (per calibrare il match).
  if (trovato) {
    const c = trovato.corpo;
    console.log(`\n  [corpo #${trovato.id}] contiene «${nomePiatto}» (nome intero)? ${c.includes(nomePiatto)}`);
    const primaParola = parole.find((p) => c.includes(p));
    const i = primaParola ? c.indexOf(primaParola) : -1;
    if (i >= 0) console.log(`  intorno: …${c.slice(Math.max(0, i - 40), i + 60)}…`);
  }

  console.log("");
  if (!trovato) {
    console.log(
      `→ Fra i ${candidati.length} ticket con quell'oggetto, in NESSUNO compare «${doc.nomeCliente}» nel corpo.`,
    );
    console.log("  Quindi non risulta un ticket di Arthur: dal nostro lato NON è stato chiuso da noi.");
    process.exit(0);
  }

  const stato = STATO[trovato.status] ?? `stato ${trovato.status}`;
  const chiuso = trovato.status === 4 || trovato.status === 5;
  const url = await ticketUrl(trovato.id);
  console.log(`→ Ticket di «${doc.nomeCliente}»: #${trovato.id} · STATO «${stato}»`);
  console.log(`  RISPOSTA: è ${chiuso ? "CHIUSO/RISOLTO" : "APERTO (NON chiuso)"}.`);
  console.log(`  link: ${url}`);

  // Verifica del percorso VERO dell'app: cercaTicketPerRecensione deve agganciare
  // il ticket anche col nome accentato (era il bug degli accenti).
  const via = await cercaTicketPerRecensione(
    doc.oggetto,
    new Date(doc.ricevutaIl).toISOString(),
    doc.nomeCliente,
  );
  console.log(
    `\n  [verifica match app] cercaTicketPerRecensione → ${via.ticket ? `#${via.ticket.id} ✓ (${via.motivo})` : `NIENTE (${via.motivo})`}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
