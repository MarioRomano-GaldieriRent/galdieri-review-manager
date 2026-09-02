import { readFileSync } from "node:fs";
import path from "node:path";

// Replica il flusso di «Da approvare» PESCANDO DAL DB, come lo vedrebbe un
// utente (con le sue regole in anteprima). SOLA LETTURA.
//   npm run diag:daapprovare               → occhio spento, nessuna anteprima
//   npm run diag:daapprovare -- mario      → come lo vede «mario» (con le sue beta)

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
  const { recensioniDaApprovare } = await import("@/server/db/recensioni");
  const { chiaviPubblicate } = await import("@/server/db/pubblicazioni");
  const { recensioniConTicket, recensioniConTicketRisolto, isFreshdeskConfigured } = await import(
    "@/server/integrations/freshdesk"
  );
  const { caricaRegole, conBeta, regolaPer } = await import("@/server/automation/rules");
  const { haTesto } = await import("@/server/reviews/load");

  // Utente (facoltativo): applica le sue regole in anteprima.
  let regoleBeta: string[] = [];
  const identif = process.argv[2];
  if (identif) {
    const { elencoUtenti } = await import("@/server/auth/utenti");
    const q = identif.toLowerCase();
    const u = (await elencoUtenti()).find(
      (x) => x.chiave.toLowerCase() === q || (x.email ?? "").toLowerCase() === q,
    );
    if (!u) {
      console.error(`Nessun utente «${identif}».`);
      process.exit(1);
    }
    regoleBeta = u.regoleBeta ?? [];
    console.log(`Vista di ${u.chiave} · anteprime: ${regoleBeta.join(", ") || "—"}\n`);
  }

  const cand = await recensioniDaApprovare();
  console.log(`Candidate dall'archivio (ultimi 30 gg): ${cand.length}`);

  const pubblicate = await chiaviPubblicate().catch(() => new Set<string>());
  const regole = conBeta(await caricaRegole(), regoleBeta);

  let lista = cand
    .filter((r) => !pubblicate.has(r.chiave))
    .map((r) => ({ r, regola: regolaPer(regole, r.stelle, haTesto(r)) }))
    .filter((x) => x.regola !== null);
  console.log(`Dopo «non pubblicate» + regola attiva: ${lista.length}`);

  if (await isFreshdeskConfigured()) {
    const risolte = await recensioniConTicketRisolto(
      lista.map((x) => ({ chiave: x.r.chiave, oggetto: x.r.oggetto, ricevutaIl: x.r.ricevutaIl, nome: x.r.nome })),
    );
    lista = lista.filter((x) => !risolte.has(x.r.chiave));
    console.log(`Dopo il filtro ticket Freshdesk risolto: ${lista.length}`);

    // Negative già inoltrate (regola con inoltro + ticket già aperto).
    const daInoltrare = lista.filter((x) => x.regola!.azioni.some((a) => a.tipo === "email.inoltra"));
    if (daInoltrare.length > 0) {
      const inoltrate = await recensioniConTicket(
        daInoltrare.map((x) => ({ chiave: x.r.chiave, oggetto: x.r.oggetto, ricevutaIl: x.r.ricevutaIl, nome: x.r.nome })),
      );
      lista = lista.filter((x) => !inoltrate.has(x.r.chiave));
      console.log(`Dopo «negative già inoltrate»: ${lista.length} (nascoste ${inoltrate.size})`);
    }
    console.log("");
  }

  console.log("→ «Da approvare» mostrerebbe:");
  if (lista.length === 0) console.log("   (niente: coda pulita)");
  for (const { r } of lista) {
    console.log(`   • ${r.nome} · ${r.stelle}★ · ${r.sede || "—"} · ${new Date(r.ricevutaIl).toISOString().slice(0, 10)}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
