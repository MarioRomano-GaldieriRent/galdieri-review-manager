import { readFileSync } from "node:fs";
import path from "node:path";

// Un giro del pilota automatico IN PROVA: legge le regole, la posta e i ticket,
// e dice quali recensioni lavorerebbe adesso — senza lanciare il robot, senza
// pubblicare, senza aprire segnalazioni. Serve a guardare cosa farebbe prima di
// accendere AUTOPILOTA=1, o a capire perché una recensione non è partita.
//
//   npm run pilota:prova
//   npm run pilota:prova -- --giorni 3   → come se fosse accesa da 3 giorni

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
  const { automazioneDi, dentroFascia, regolaAutomatizzabile } = await import("@/server/automation/types");
  const { aOraItaliana, giornoSettimana } = await import("@/server/tempo");

  const ora = new Date();
  const locale = aOraItaliana(ora.toISOString());
  const oraDec = Number(locale.slice(11, 13)) + Number(locale.slice(14, 16)) / 60;
  const giorno = giornoSettimana(ora.toISOString());

  console.log(`Adesso a Roma: ${locale.replace("T", " ")} (giorno ${giorno})`);
  console.log(`AUTOPILOTA in questo .env: ${process.env.AUTOPILOTA === "1" ? "1 (acceso)" : "non impostato → qui il pilota NON parte"}\n`);
  for (const r of (await caricaRegole()).filter((x) => x.attiva && automazioneDi(x).modo !== "manuale")) {
    const a = automazioneDi(r);
    console.log(
      `«${r.nome}»: ${a.modo} · ${regolaAutomatizzabile(r) ? "automatizzabile" : "NON automatizzabile"} · ` +
        `adesso ${dentroFascia(a, giorno, oraDec) ? "DENTRO la fascia" : "fuori fascia"}`,
    );
  }

  const iGiorni = process.argv.indexOf("--giorni");
  const giorni = iGiorni > 0 ? Number(process.argv[iGiorni + 1]) : 0;
  const daProva = giorni > 0 ? new Date(ora.getTime() - giorni * 86_400_000) : undefined;
  if (daProva) console.log(`
(prova: come se l'automazione fosse accesa da ${giorni} giorni)`);
  const e = await giroPilota({ prova: true, daProva });
  console.log(`\n${e.messaggio}`);
  for (const c of e.candidate ?? []) {
    console.log(
      `  · ${c.stelle}★ «${c.nome}» — regola ${c.regola}, arrivata ${new Date(c.ricevutaIl).toLocaleString("it-IT", { timeZone: "Europe/Rome" })}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("ERRORE:", err instanceof Error ? err.message : err);
  process.exit(1);
});
