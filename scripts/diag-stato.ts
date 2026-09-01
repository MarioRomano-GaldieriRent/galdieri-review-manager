import { readFileSync } from "node:fs";
import path from "node:path";

// Per una lista di recensori, dice cosa SAPPIAMO sullo stato della loro
// recensione: risposta nel thread email? pubblicata da noi? ticket Freshdesk
// aperto o risolto? SOLA LETTURA. NB: nessuno di questi è la prova che sia
// risposta SU GOOGLE — è il ticket l'indizio più forte, ma la certezza la dà
// solo guardare Google (col robot).
//
//   npm run diag:stato -- "Giacomo Vero; Paco Martin; Julian Dobras; leonardo del gaudio"

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

const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : ((input as Request).url ?? String(input));
  const metodo = (init?.method ?? "GET").toUpperCase();
  const soloToken = /login\.microsoftonline\.com/.test(url);
  if (metodo !== "GET" && !soloToken) throw new Error(`SCRITTURA BLOCCATA: ${metodo} ${url}`);
  return fetchVero(input, init);
}) as typeof fetch;

async function main() {
  const nomi = process.argv
    .slice(2)
    .join(" ")
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (nomi.length === 0) {
    console.log('Uso: npm run diag:stato -- "Nome Uno; Nome Due; …"');
    process.exit(1);
  }

  const { coll } = await import("@/server/db/connessione");
  const { chiaviPubblicate } = await import("@/server/db/pubblicazioni");
  const { cercaTicketPerRecensione, getTicket, STATO, isFreshdeskConfigured, recensioniConTicketRisolto } =
    await import("@/server/integrations/freshdesk");

  const rec = await coll("recensioni");
  const pubblicate = await chiaviPubblicate().catch(() => new Set<string>());
  const fdOk = await isFreshdeskConfigured();
  const perSweep: { chiave: string; oggetto: string; ricevutaIl: string; nome: string }[] = [];

  for (const nome of nomi) {
    const doc = (await rec
      .find({ nomeCliente: { $regex: nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } })
      .sort({ ricevutaIl: -1 })
      .limit(1)
      .toArray()) as {
      _id: string;
      nomeCliente: string;
      stelle: number | null;
      oggetto: string;
      ricevutaIl: Date;
      haRisposta?: boolean;
      risolto?: boolean;
      archiviata?: boolean;
      sede?: { nome?: string };
    }[];

    console.log("\n" + "─".repeat(70));
    if (doc.length === 0) {
      console.log(`«${nome}» → non trovato in archivio.`);
      continue;
    }
    const d = doc[0];
    perSweep.push({
      chiave: d._id,
      oggetto: d.oggetto,
      ricevutaIl: new Date(d.ricevutaIl).toISOString(),
      nome: d.nomeCliente,
    });
    console.log(`«${d.nomeCliente}» · ${d.stelle ?? "?"}★ · ${d.sede?.nome ?? "—"} · ${new Date(d.ricevutaIl).toISOString().slice(0, 10)}`);
    console.log(`  risposta nel thread email? ${d.haRisposta ? "SÌ" : "no"}`);
    console.log(`  pubblicata da noi?          ${pubblicate.has(d._id) ? "SÌ" : "no"}`);
    console.log(`  archiviata?                 ${d.archiviata ? "SÌ" : "no"}`);

    let statoTicket = "Freshdesk non configurato";
    let risolto = false;
    if (fdOk) {
      const { ticket, motivo } = await cercaTicketPerRecensione(
        d.oggetto,
        new Date(d.ricevutaIl).toISOString(),
        d.nomeCliente,
      );
      if (ticket) {
        const t = await getTicket(ticket.id);
        risolto = t.status === 4 || t.status === 5;
        statoTicket = `#${t.id} · ${STATO[t.status] ?? t.status}`;
      } else {
        statoTicket = `nessun ticket agganciato (${motivo})`;
      }
    }
    console.log(`  ticket Freshdesk:           ${statoTicket}`);

    const rispostaNostra = pubblicate.has(d._id) || d.haRisposta;
    const verdetto = rispostaNostra
      ? "RISPOSTA (da noi o nel thread)"
      : risolto
        ? "ticket RISOLTO → probabilmente già gestita da qualcuno (verifica su Google)"
        : "NESSUN segnale di risposta → verosimilmente DA RISPONDERE";
    console.log(`  → ${verdetto}`);
  }

  // Verifica del FILTRO vero della home: quali nasconderebbe la sweep condivisa
  // (recensioniConTicketRisolto) usata da «Da approvare».
  if (fdOk && perSweep.length > 0) {
    console.log("\n" + "═".repeat(70));
    console.log("Filtro «Da approvare» (recensioniConTicketRisolto) — chi verrebbe NASCOSTO:");
    try {
      const risolte = await recensioniConTicketRisolto(perSweep);
      for (const r of perSweep) {
        console.log(`  ${risolte.has(r.chiave) ? "NASCOSTA ✓" : "resta in lista"} — ${r.nome}`);
      }
    } catch (e) {
      console.log(`  (sweep fallita: ${e instanceof Error ? e.message : e})`);
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log("NB: solo guardare Google dà la certezza. Posso farlo col robot, sede per sede.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
