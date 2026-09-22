import { readFileSync } from "node:fs";
import path from "node:path";

// Un giro del pilota automatico IN PROVA: legge le regole, la posta e i ticket,
// e dice quali recensioni lavorerebbe adesso — senza lanciare il robot, senza
// pubblicare, senza aprire segnalazioni. Serve a guardare cosa farebbe prima di
// accendere AUTOPILOTA=1, o a capire perché una recensione non è partita.
//
//   npm run pilota:prova
//   npm run pilota:prova -- --negative-in-automatico
//       come sopra, ma FACENDO FINTA che la regola delle 1-2★ sia già in
//       automatico (con le fasce della prima regola automatica): mostra cosa
//       inoltrerebbe e cosa pubblicherebbe, senza toccare la regola salvata.

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

// In prova nessuna scrittura esterna: le sole POST ammesse sono il login di
// Microsoft (per leggere la posta) e le domande all'IA sulla lingua del nome.
const fetchVero = globalThis.fetch;
globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof i === "string" ? i : ((i as Request).url ?? String(i));
  const metodo = (init?.method ?? "GET").toUpperCase();
  if (metodo !== "GET" && !/login\.microsoftonline\.com|api\.anthropic\.com/.test(url)) {
    throw new Error(`SCRITTURA ESTERNA BLOCCATA: ${metodo} ${url}`);
  }
  return fetchVero(i, init);
}) as typeof fetch;

async function main() {
  const { giroPilota } = await import("@/server/automation/pilota");
  const { caricaRegole } = await import("@/server/automation/rules");
  const { automazioneDi, dentroFascia, regolaAutomatizzabile, regolaEscalationAutomatizzabile } = await import(
    "@/server/automation/types"
  );
  const { aOraItaliana, giornoSettimana } = await import("@/server/tempo");

  const ora = new Date();
  const locale = aOraItaliana(ora.toISOString());
  const oraDec = Number(locale.slice(11, 13)) + Number(locale.slice(14, 16)) / 60;
  const giorno = giornoSettimana(ora.toISOString());

  console.log(`Adesso a Roma: ${locale.replace("T", " ")} (giorno ${giorno})`);
  console.log(`AUTOPILOTA in questo .env: ${process.env.AUTOPILOTA === "1" ? "1 (acceso)" : "non impostato → qui il pilota NON parte"}\n`);
  for (const r of (await caricaRegole()).filter((x) => x.attiva && automazioneDi(x).modo !== "manuale")) {
    const a = automazioneDi(r);
    const tipo = regolaAutomatizzabile(r)
      ? "positiva automatizzabile"
      : regolaEscalationAutomatizzabile(r)
        ? "escalation 1-2★ automatizzabile (inoltro subito, pubblicazione in fascia)"
        : "NON automatizzabile";
    console.log(
      `«${r.nome}»: ${a.modo} · ${tipo} · adesso ${dentroFascia(a, giorno, oraDec) ? "DENTRO la fascia" : "fuori fascia"}`,
    );
  }

  // Anteprima: la regola 1-2★ «come se» fosse accesa, con le fasce della
  // prima regola già in automatico (o quelle di default). Solo in memoria.
  let regoleProva: Awaited<ReturnType<typeof caricaRegole>> | undefined;
  if (process.argv.includes("--negative-in-automatico")) {
    const tutte = await caricaRegole();
    const modello = tutte.find((x) => x.attiva && automazioneDi(x).modo !== "manuale");
    regoleProva = tutte.map((x) =>
      regolaEscalationAutomatizzabile(x)
        ? { ...x, automazione: { ...automazioneDi(modello ?? x), modo: "programmato" as const } }
        : x,
    );
    const neg = regoleProva.find(regolaEscalationAutomatizzabile);
    if (neg) {
      const a = automazioneDi(neg);
      const fasce = JSON.stringify({ giorni: a.giorni, daOra: a.daOra, aOra: a.aOra, pausa: a.pausa });
      console.log(
        `ANTEPRIMA: «${neg.nome}» trattata COME SE fosse in automatico a fasce (${fasce}). La regola salvata non cambia.`,
      );
    } else {
      console.log("ANTEPRIMA: nessuna regola di escalation 1-2★ trovata.");
    }
    console.log("");
  }

  const e = await giroPilota({ prova: true, regole: regoleProva });
  console.log(`\n${e.messaggio}`);
  const COSA = {
    inoltro: "da INOLTRARE a Cherubina (Fase 1, subito)",
    "risposta-customer-care": "risposta di Cherubina da PUBBLICARE (Fase 2, in fascia)",
    risposta: "positiva da RISPONDERE (in fascia)",
  } as const;
  for (const fase of ["inoltro", "risposta-customer-care", "risposta"] as const) {
    const qui = (e.candidate ?? []).filter((c) => c.fase === fase);
    if (qui.length === 0) continue;
    console.log(`\n${COSA[fase]}: ${qui.length}`);
    for (const c of qui) {
      const quando = new Date(c.ricevutaIl).toLocaleString("it-IT", { timeZone: "Europe/Rome" });
      console.log(`  · ${c.stelle}★ «${c.nome}» — regola ${c.regola}, arrivata ${quando}`);
      if (c.bloccata) console.log(`      ✋ NON la pubblicherebbe: ${c.bloccata} → andrebbe in Supervisione`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("ERRORE:", err instanceof Error ? err.message : err);
  process.exit(1);
});
