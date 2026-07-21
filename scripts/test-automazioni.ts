import { readFileSync } from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Suite di prova delle automazioni.
//
// Fa girare le regole sui dati VERI (email reali, ticket reali) restando in
// modalità simulazione, e verifica che non parta nessuna scrittura.
//
// La verifica non si fida del codice: sostituisce il fetch globale con un
// guardiano che SOLLEVA UN ERRORE se qualcuno prova a fare POST/PUT/PATCH/
// DELETE verso Freshdesk, Google o Microsoft Graph. Se lo script termina con
// "simulazione sicura", nessuna scrittura è partita davvero.
//
//   npm run test:automazioni
// ---------------------------------------------------------------------------

function loadEnv() {
  const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (!v.startsWith('"') && !v.startsWith("'")) {
      const c = v.indexOf(" #");
      if (c >= 0) v = v.slice(0, c).trim();
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const chiamate: { metodo: string; url: string }[] = [];
let tentativiBloccati = 0;

const fetchVero = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
  const metodo = (init?.method ?? "GET").toUpperCase();
  chiamate.push({ metodo, url });

  const versoEsterno = /freshdesk\.com|mybusiness\.googleapis|graph\.microsoft\.com/.test(url);
  // La POST verso login.microsoftonline.com serve solo a ottenere il token:
  // non modifica nulla, quindi è consentita.
  const soloToken = /login\.microsoftonline\.com/.test(url);

  if (metodo !== "GET" && versoEsterno && !soloToken) {
    tentativiBloccati++;
    throw new Error(`SCRITTURA NON AUTORIZZATA BLOCCATA: ${metodo} ${url}`);
  }
  return fetchVero(input, init);
}) as typeof fetch;

async function main() {
  const { loadSettings, modoOperativo } = await import("@/server/settings");
  const { caricaRecensioni, haTesto, testoRecensione } = await import("@/server/reviews/load");
  const { caricaRegole, regolaPer } = await import("@/server/automation/rules");
  const { eseguiRegola } = await import("@/server/automation/engine");
  const { tagSede } = await import("@/server/automation/sedi");

  const modo = await modoOperativo();
  console.log(`Modalità operativa: ${modo}`);
  if (modo === "reale") {
    console.log(
      "\nATTENZIONE: la modalità reale è attiva. Questo test si rifiuta di girare,\n" +
        "perché farebbe partire scritture vere. Rimetti la simulazione in Impostazioni.",
    );
    process.exit(1);
  }

  const settings = await loadSettings();
  const label = settings.labels[0];
  if (!label) throw new Error("Nessuna etichetta configurata.");

  const { recensioni, analizzate } = await caricaRecensioni(label);
  const regole = await caricaRegole();
  console.log(`${recensioni.length} recensioni da ${analizzate} email.\n`);

  // Un caso reale per ciascuna regola: si copre tutto il ventaglio.
  const campione = new Map<string, (typeof recensioni)[number]>();
  const senzaRegola: string[] = [];
  for (const r of recensioni) {
    const reg = regolaPer(regole, r.stelle, haTesto(r));
    if (!reg) {
      senzaRegola.push(`${r.nome} (${r.stelle}★)`);
      continue;
    }
    if (!campione.has(reg.id)) campione.set(reg.id, r);
  }

  console.log(`Regole con un caso reale: ${campione.size} su ${regole.length}`);
  const scoperte = regole.filter((r) => !campione.has(r.id)).map((r) => r.nome);
  if (scoperte.length) console.log(`Senza casi nelle ultime email: ${scoperte.join(", ")}`);
  if (senzaRegola.length) console.log(`Recensioni senza regola: ${senzaRegola.join(", ")}`);
  console.log("");

  let errori = 0;

  for (const [regolaId, rec] of campione) {
    const regola = regole.find((x) => x.id === regolaId)!;
    console.log("=".repeat(78));
    console.log(`REGOLA     ${regola.nome}`);
    console.log(`RECENSIONE ${rec.nome} — ${rec.stelle}★ — ${rec.sede} → tag "${tagSede(rec.sede)}"`);
    console.log(`TESTO      ${testoRecensione(rec).slice(0, 90) || "(nessun commento)"}`);
    console.log("-".repeat(78));

    const e = await eseguiRegola(regola, rec);
    for (const n of e.nodi) {
      const simbolo = { ok: "OK ", simulato: "SIM", saltato: "-- ", errore: "ERR" }[n.stato];
      console.log(`  [${simbolo}] ${n.titolo.padEnd(22)} ${n.messaggio}`);
      if (n.chiamata) {
        console.log(`         → ${n.chiamata.metodo} ${n.chiamata.url}`);
        if (n.chiamata.corpo) {
          for (const l of n.chiamata.corpo.split("\n")) console.log(`           ${l}`);
        }
      }
    }
    if (e.esito === "errore") errori++;
    console.log(`  esito: ${e.esito}\n`);
  }

  // ------------------------------------------------------------- verdetto
  const letture = chiamate.filter((c) => c.metodo === "GET").length;
  const token = chiamate.filter((c) => /login\.microsoftonline/.test(c.url)).length;
  const scritture = chiamate.length - letture - token;

  console.log("=".repeat(78));
  console.log(`Chiamate HTTP: ${chiamate.length}  (lettura ${letture}, token ${token})`);
  console.log(`Scritture partite:            ${scritture}   ← deve essere 0`);
  console.log(`Scritture bloccate a forza:   ${tentativiBloccati}   ← deve essere 0`);
  console.log(`Regole con esito di errore:   ${errori}`);

  if (scritture === 0 && tentativiBloccati === 0) {
    console.log("\nESITO: nessuna scrittura verso l'esterno. Simulazione sicura.");
  } else {
    console.log("\nESITO: sono partite delle scritture. Il blocco non ha funzionato.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
