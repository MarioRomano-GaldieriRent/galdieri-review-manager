import { mkdirSync } from "fs";
import path from "path";
import {
  apriContesto,
  cercaNeiGruppiPerPagina,
  pubblica,
  rispondiPerSede,
  sessioneAttiva,
  SCREENSHOT_DIR,
} from "@/server/robot/google";

// Runner NON interattivo del robot, avviato dai bottoni della card (▶ Play /
// 🔍 Test Google / G). Il lavoro arriva nell'env ROBOT_JOB come JSON:
//
//   { "azione": "test"|"pubblica"|"cerca", "nome": "...", "testo": "Grazie.",
//     "nomeGoogle": "Galdieri Rent …" }   ← nomeGoogle facoltativo (dal Mapping)
//
// Strategia:
//   1. se la sede è MAPPATA (nomeGoogle) → va DRITTO sulla sede: la cerca su
//      Google, apre «Leggi recensioni», trova il cliente e scrive;
//   2. altrimenti (o se lì non la trova) → ripiega sulla ricerca fra i GRUPPI in
//      ampiezza: pagina 1 di tutti i gruppi, poi pagina 2, ecc.
//
//   test     → trova e scrive il testo, poi SI FERMA (niente di reale).
//   pubblica → trova, scrive e clicca «Pubblica risposta» (reale su Google).
//   cerca    → trova, scrive la bozza e LASCIA la finestra aperta all'operatore.
//
// Stampa UNA riga  __ESITO__ {json}  e chiude (tranne "cerca", che resta aperta).

type Job = {
  azione: "test" | "pubblica" | "cerca";
  nome: string;
  testo: string;
  nomeGoogle: string;
};
const AZIONI = ["test", "pubblica", "cerca"] as const;

function leggiJob(): Job {
  const raw = process.env.ROBOT_JOB || process.argv[2] || "";
  const j = JSON.parse(raw) as Partial<Job>;
  if (!j.nome || !j.azione || !(AZIONI as readonly string[]).includes(j.azione)) {
    throw new Error("ROBOT_JOB non valido");
  }
  return {
    azione: j.azione,
    nome: j.nome.trim(),
    testo: (j.testo || "Grazie.").trim(),
    nomeGoogle: (j.nomeGoogle || "").trim(),
  };
}

function esito(o: Record<string, unknown>): void {
  console.log("__ESITO__ " + JSON.stringify(o));
}

const traccia = (m: string) => console.error("   " + m);

(async () => {
  const job = leggiJob();
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  let ctx;
  try {
    ctx = await apriContesto(false);
  } catch (e) {
    // Quasi sempre: "Chrome è aperto". Messaggio corto e azionabile sulla card.
    esito({ ok: false, stato: "chrome-aperto", messaggio: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }

  // "cerca": lascia il browser aperto finché l'operatore non chiude la finestra
  // (o 30 min): può proseguire lui a mano.
  const attendiChiusura = () =>
    new Promise<void>((res) => {
      ctx.once("close", () => res());
      setTimeout(res, 30 * 60 * 1000);
    });

  try {
    const page0 = ctx.pages()[0] ?? (await ctx.newPage());
    if (!(await sessioneAttiva(page0))) {
      esito({ ok: false, stato: "non-loggato", messaggio: "Robot non loggato su Google. Lancia: npm run robot:sessione" });
      return;
    }

    // Esito unificato dei due percorsi (per-sede e gruppi).
    let trovata = false;
    let scritto = false;
    let dove = "";
    let dettaglio = "";
    let paginaAperta = page0; // scheda da tenere in primo piano / fotografare
    let root: Awaited<ReturnType<typeof rispondiPerSede>>["root"] = null; // dove sta il riquadro

    // 1) PER SEDE, se mappata: si va dritti lì.
    if (job.nomeGoogle) {
      traccia(`sede mappata: vado dritto su «${job.nomeGoogle}»…`);
      const ps = await rispondiPerSede(page0, job.nomeGoogle, job.nome, job.testo, { log: traccia });
      dettaglio = ps.dettaglio;
      if (ps.trovata) {
        trovata = true;
        scritto = ps.scritto;
        root = ps.root;
        paginaAperta = page0;
        dove = `sede «${job.nomeGoogle}»`;
      } else {
        traccia(`per sede non trovata (${ps.dettaglio}); ripiego sui gruppi…`);
      }
    }

    // 2) FALLBACK: ricerca IN AMPIEZZA fra i gruppi (pag. 1 di tutti, poi 2, …).
    if (!trovata) {
      const ric = await cercaNeiGruppiPerPagina(ctx, job.nome, job.testo, { maxPagine: 5, log: traccia });
      dettaglio = ric.dettaglio;
      if (ric.trovata && ric.page) {
        trovata = true;
        scritto = ric.scritto;
        root = ric.page;
        paginaAperta = ric.page;
        dove = `gruppo «${ric.gruppo ?? ""}»`;
      }
    }

    // --- Esito ---------------------------------------------------------------
    if (!trovata || !root) {
      // "cerca": anche se non l'ho trovata, lascio Google APERTO per l'operatore.
      if (job.azione === "cerca") {
        esito({ ok: true, stato: "aperta-non-trovata", trovata: false, messaggio: `Non ho trovato «${job.nome}» da solo: ho lasciato Google aperto, cercala tu nella finestra.` });
        await attendiChiusura();
        return;
      }
      esito({ ok: false, stato: "non-trovata", trovata: false, messaggio: `«${job.nome}» non trovata. ${dettaglio}` });
      return;
    }

    await paginaAperta.bringToFront().catch(() => {});
    await paginaAperta
      .screenshot({ path: path.join(SCREENSHOT_DIR, `esegui-${job.azione}.png`) })
      .catch(() => {});

    // "cerca": si FERMA sulla recensione (risposta già pronta nel riquadro) e
    // LASCIA il browser aperto: procede l'operatore.
    if (job.azione === "cerca") {
      esito({ ok: true, stato: "aperta", trovata: true, scritto, gruppo: dove, messaggio: `Fermo sulla recensione di «${job.nome}» in ${dove}. Procedi tu nella finestra.` });
      await attendiChiusura();
      return;
    }

    if (!scritto) {
      esito({ ok: false, stato: "trovata-non-scritta", trovata: true, gruppo: dove, messaggio: `Trovata in ${dove} ma non ho potuto scrivere: ${dettaglio}` });
      return;
    }

    if (job.azione === "test") {
      esito({ ok: true, stato: "scritta", trovata: true, scritto: true, gruppo: dove, messaggio: `Trovata in ${dove} e scritto «${job.testo}». NON pubblicata (test).` });
      return;
    }

    // azione "pubblica": clicca «Pubblica risposta» solo se è abilitata.
    const abilitato = await root
      .getByRole("button", { name: /Pubblica risposta/i })
      .isEnabled()
      .catch(() => false);
    if (!abilitato) {
      esito({ ok: false, stato: "pubblica-non-abilitata", trovata: true, gruppo: dove, messaggio: `Trovata in ${dove}, testo scritto, ma «Pubblica risposta» non è attivo.` });
      return;
    }
    try {
      await pubblica(root);
      await paginaAperta.waitForTimeout(2500);
      await paginaAperta
        .screenshot({ path: path.join(SCREENSHOT_DIR, "esegui-pubblicata.png") })
        .catch(() => {});
      esito({ ok: true, stato: "pubblicata", trovata: true, scritto: true, gruppo: dove, messaggio: `Pubblicata su Google in ${dove}.` });
    } catch (err) {
      esito({ ok: false, stato: "pubblica-errore", trovata: true, gruppo: dove, messaggio: `Trovata e scritta, ma la pubblicazione è fallita: ${err instanceof Error ? err.message : String(err)}` });
    }
  } catch (e) {
    esito({ ok: false, stato: "errore", messaggio: e instanceof Error ? e.message : String(e) });
  } finally {
    await ctx.close().catch(() => {});
  }
  process.exit(0);
})().catch((e) => {
  esito({ ok: false, stato: "errore", messaggio: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
