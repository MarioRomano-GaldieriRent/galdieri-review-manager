import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  apriContesto,
  apriSedePerNome,
  cercaClienteNelleRecensioni,
  rispondiAllaRecensione,
  sessioneAttiva,
  SCREENSHOT_DIR,
} from "@/server/robot/google";

// TEST della «parte 2» del mapping. Cinque passi, in ordine:
//   1. cerca SOLO il nome dell'attività (la sede) nella barra di Google;
//   2. clicca l'attività;
//   3. clicca «Leggi recensioni»;
//   4. cerca il nome del CLIENTE nel campo di ricerca delle recensioni;
//   5. clicca «Rispondi» accanto alla sua recensione e SCRIVE «Grazie.» (bozza).
// NON pubblica MAI (non clicca «Pubblica risposta»): il testo resta una bozza
// nel riquadro. Lascia la finestra aperta; screenshot in data/robot-screenshot.
//
// Prima chiudi TUTTE le finestre di Chrome (il robot apre il suo).
//
// I pezzi si passano in UN SOLO argomento fra virgolette, separati da //
// così la barra riceve SOLO la sede (mai sede + cliente):
//
//   "sede"                       apre solo la sede
//   "sede // cliente"            sede, cliente, clicca «Rispondi» e scrive «Grazie.»
//   "sede // cliente // testo"   scrive quel testo invece di «Grazie.»
//   "sede // cliente // "        clicca «Rispondi» ma NON scrive (riquadro vuoto)
//
// Esempio:
//   npm run robot:prova-sede -- "Galdieri Rent Orio al Serio - Milan Bergamo // Arthur Lavallée"
//
// (Le sedi si mappano in Impostazioni → Mapping sedi.)

function caricaEnv() {
  try {
    const txt = readFileSync(path.join(process.cwd(), ".env"), "utf8");
    for (const riga of txt.split(/\r?\n/)) {
      const m = riga.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* senza .env si prosegue */
  }
}
caricaEnv();

async function main() {
  // UN solo argomento: "sede // cliente". Tutto prima di // è la SEDE (va nella
  // barra di ricerca attività), tutto dopo è il CLIENTE (va nella ricerca delle
  // recensioni). Così la barra riceve SOLO la sede, mai sede + cliente.
  const raw = process.argv.slice(2).join(" ").trim();
  const parti = raw.split("//");
  const argNome = (parti[0] ?? "").trim();
  const cliente = (parti[1] ?? "").trim();
  // Testo della risposta: di default «Grazie.». Clicca «Rispondi» e lo SCRIVE
  // nel riquadro come bozza — ma NON pubblica mai. Con "// vuoto" (terzo pezzo
  // presente ma vuoto) apre solo il riquadro senza scrivere.
  const testoRisposta = parti.length >= 3 ? (parti[2] ?? "").trim() : "Grazie.";

  let nomeGoogle = argNome;
  if (!nomeGoogle) {
    // Nessun argomento: leggo il mapping dal database e uso la prima sede.
    const { leggiSedi } = await import("@/server/db/sedi");
    const mappate = (await leggiSedi()).filter((s) => s.nomeGoogle.trim());
    if (mappate.length === 0) {
      console.log(
        "Nessuna sede mappata. Vai in Impostazioni → Mapping sedi e scrivi il nome Google di almeno una sede.",
      );
      process.exit(1);
    }
    console.log(`Sedi mappate (${mappate.length}):`);
    for (const s of mappate) console.log(`  - ${s.nome}  →  «${s.nomeGoogle}»`);
    nomeGoogle = mappate[0].nomeGoogle;
    console.log(`\nProvo la PRIMA. Per un'altra:  npm run robot:prova-sede -- "Nome Google"\n`);
  }

  console.log(`\nNella barra cerco SOLO l'attività: «${nomeGoogle}»`);
  console.log(`Poi, nelle recensioni, cerco il cliente: «${cliente || "(nessuno)"}»\n`);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!(await sessioneAttiva(page))) {
    console.log("Non risulti loggato su Google. Fai prima:  npm run robot:sessione");
    await ctx.close();
    process.exit(1);
  }

  const esito = await apriSedePerNome(page, nomeGoogle, { log: (m) => console.log("   " + m) });
  console.log(`\n→ ${esito.aperta ? "APERTA ✓" : "non aperta"} · via ${esito.via} · ${esito.dettaglio}`);

  // Se abbiamo un cliente e siamo sulle recensioni, lo cerchiamo nella radice
  // giusta (le recensioni della sede stanno in un iframe: la usa esito.root) e
  // poi proviamo a rispondere — SCRIVENDO la bozza, senza pubblicare nulla.
  if (cliente && esito.aperta && esito.root) {
    const root = esito.root;
    console.log(`\nCerco la recensione di «${cliente}» in questa sede…`);
    const t = await cercaClienteNelleRecensioni(root, cliente, { log: (m) => console.log("   " + m) });
    console.log(`\n→ ${t.trovata ? "TROVATA ✓" : "non trovata"} · ${t.dettaglio}`);

    if (t.trovata) {
      if (testoRisposta) {
        console.log(`\nClicco «Rispondi» e scrivo «${testoRisposta}» — bozza, NON pubblico…`);
      } else {
        console.log(`\nClicco «Rispondi» — senza scrivere niente…`);
      }
      const r = await rispondiAllaRecensione(root, cliente, testoRisposta, {
        log: (m) => console.log("   " + m),
      });
      console.log(`\n→ ${r.via} · ${r.dettaglio}`);
    }
  } else if (cliente) {
    console.log(`\n(Non cerco «${cliente}»: non sono arrivato alle recensioni della sede.)`);
  }

  console.log("\n>>> Lascio la finestra APERTA. NON ho pubblicato niente su Google.");
  console.log(">>> (Se avevo un testo, è solo una bozza nel riquadro: la pubblichi TU o si scarta.)");
  console.log(`>>> Screenshot delle tappe in: ${SCREENSHOT_DIR}`);
  console.log(">>> Quando hai finito, torna qui e premi INVIO per chiudere.\n");
  await new Promise<void>((ok) => process.stdin.once("data", () => ok()));

  await ctx.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRORE:", e instanceof Error ? e.message : e);
  process.exit(1);
});
