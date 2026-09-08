import { mkdirSync } from "fs";
import path from "path";
import {
  apriContesto,
  apriSedePerNome,
  cercaNeiGruppiPerPagina,
  provaCodaIgnora,
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
  azione: "test" | "pubblica" | "cerca" | "prova-coda";
  nome: string;
  testo: string;
  nomeGoogle: string;
  /** Testo della recensione dal database: serve alla coda per riconoscerla. */
  testoRecensione: string;
};
const AZIONI = ["test", "pubblica", "cerca", "prova-coda"] as const;

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
    testoRecensione: (j.testoRecensione || "").trim(),
  };
}

function esito(o: Record<string, unknown>): void {
  // Il passo-passo lo infila l'esito stesso: prima ogni ramo doveva ricordarsi
  // di aggiungerlo e infatti se lo ricordava solo quello di prova — il
  // «Rispondi» arrivava sulla card muto, e non si capiva se la coda avesse
  // finito i salti o fosse scaduta. Chi vuole può sempre sovrascriverlo.
  console.log("__ESITO__ " + JSON.stringify({ log: [...diario], ...o }));
}

/**
 * Ogni rigo di traccia va su stderr (per chi guarda il terminale) E in questo
 * elenco, che finisce nel campo `log` dell'esito: senza di questo i passi
 * fatti PRIMA della coda (apertura della sede) si perdevano, e sulla card non
 * si vedeva niente su cui ragionare.
 */
const diario: string[] = [];
const traccia = (m: string) => {
  diario.push(m);
  console.error("   " + m);
};

/** Momento in cui questo processo è partito: serve per la scadenza interna. */
const AVVIO = Date.now();

(async () => {
  const job = leggiJob();
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  let ctx;
  try {
    ctx = await apriContesto(false);
  } catch (e) {
    // Quasi sempre: "Chrome è aperto". Messaggio corto e azionabile sulla card.
    esito({
      ok: false,
      stato: "chrome-aperto",
      messaggio: e instanceof Error ? e.message : String(e),
    });
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
      esito({
        ok: false,
        stato: "non-loggato",
        messaggio: "Robot non loggato su Google. Lancia: npm run robot:sessione",
      });
      return;
    }

    // "prova-coda": METODO DI PROVA, percorso a sé — usa la coda «Rispondi alle
    // recensioni» + «Ignora» invece di scorrere/cercare nella lista. Solo
    // per-sede (nessun ripiego sui gruppi: qui si vuole isolare il metodo
    // nuovo per vedere se regge da solo). NON pubblica MAI.
    if (job.azione === "prova-coda") {
      if (!job.nomeGoogle) {
        esito({
          ok: false,
          stato: "sede-non-mappata",
          messaggio:
            "Questa sede non è mappata su Google (Impostazioni → Mapping): serve il nome esatto dell'attività per aprirla direttamente.",
          log: diario,
        });
        return;
      }
      traccia(`[prova-coda] apro la sede «${job.nomeGoogle}»…`);
      const sede = await apriSedePerNome(page0, job.nomeGoogle, { log: traccia });
      traccia(`sede: ${sede.dettaglio}`);
      // NIENTE cancello su sede.aperta: quel controllo conta i «Rispondi» della
      // LISTA, che alla coda non servono — bloccava la prova prima di provarla.
      // Basta avere un contesto DOM da cui partire.
      const radice = sede.root ?? page0;
      const prova = await provaCodaIgnora(radice, job.nome, job.testo, {
        log: traccia,
        testoRecensione: job.testoRecensione,
        // Si torna con l'esito PRIMA che chi aspetta vada in timeout muto:
        // meglio un passo-passo leggibile che «ci sta mettendo troppo».
        scadenza: AVVIO + 200_000,
      });
      await page0.bringToFront().catch(() => {});
      await page0
        .screenshot({ path: path.join(SCREENSHOT_DIR, "esegui-prova-coda.png") })
        .catch(() => {});
      esito({
        ok: prova.trovata,
        stato: prova.trovata
          ? prova.scritto
            ? "prova-scritta"
            : "prova-trovata-non-scritta"
          : "prova-non-trovata",
        trovata: prova.trovata,
        scritto: prova.scritto,
        messaggio: prova.dettaglio,
        // TUTTI i passi: prima l'apertura della sede, poi la coda. Prima
        // arrivavano solo quelli della coda e mancava metà della storia.
        log: [...diario],
      });
      // Trovata e scritta: la finestra resta APERTA sulla recensione con la
      // risposta già nel riquadro, così si controlla con i propri occhi che sia
      // quella giusta prima di decidere. La chiude l'operatore (o si chiude da
      // sé dopo 30 minuti), esattamente come fa il tasto «cerca».
      if (prova.trovata && prova.scritto) await attendiChiusura();
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
      // La coda ha una scadenza CORTA: se non conclude entro un minuto e
      // mezzo deve lasciare il tempo al ripiego sulla lista, che è la strada
      // che ha sempre funzionato.
      const ps = await rispondiPerSede(page0, job.nomeGoogle, job.nome, job.testo, {
        log: traccia,
        // Lo stesso tempo del tasto di prova: era 90 secondi, e siccome si
        // contano dall'avvio del processo (browser, sessione, apertura della
        // sede: 30-40 secondi) alla coda ne restavano una manciata. È il
        // motivo per cui la prova arrivava in fondo e il «Rispondi» no.
        scadenza: AVVIO + 200_000,
        testoRecensione: job.testoRecensione,
      });
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
      const ric = await cercaNeiGruppiPerPagina(ctx, job.nome, job.testo, {
        maxPagine: 5,
        log: traccia,
      });
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
        esito({
          ok: true,
          stato: "aperta-non-trovata",
          trovata: false,
          messaggio: `Non ho trovato «${job.nome}» da solo: ho lasciato Google aperto, cercala tu nella finestra.`,
        });
        await attendiChiusura();
        return;
      }
      esito({
        ok: false,
        stato: "non-trovata",
        trovata: false,
        messaggio: `«${job.nome}» non trovata. ${dettaglio}`,
      });
      return;
    }

    await paginaAperta.bringToFront().catch(() => {});
    await paginaAperta
      .screenshot({ path: path.join(SCREENSHOT_DIR, `esegui-${job.azione}.png`) })
      .catch(() => {});

    // "cerca": si FERMA sulla recensione (risposta già pronta nel riquadro) e
    // LASCIA il browser aperto: procede l'operatore.
    if (job.azione === "cerca") {
      esito({
        ok: true,
        stato: "aperta",
        trovata: true,
        scritto,
        gruppo: dove,
        messaggio: `Fermo sulla recensione di «${job.nome}» in ${dove}. Procedi tu nella finestra.`,
      });
      await attendiChiusura();
      return;
    }

    if (!scritto) {
      esito({
        ok: false,
        stato: "trovata-non-scritta",
        trovata: true,
        gruppo: dove,
        messaggio: `Trovata in ${dove} ma non ho potuto scrivere: ${dettaglio}`,
      });
      return;
    }

    if (job.azione === "test") {
      esito({
        ok: true,
        stato: "scritta",
        trovata: true,
        scritto: true,
        gruppo: dove,
        messaggio: `Trovata in ${dove} e scritto «${job.testo}». NON pubblicata (test).`,
      });
      return;
    }

    // azione "pubblica": invia la risposta cliccando il bottone giusto secondo
    // la UI («Pubblica risposta» nei gruppi, «Rispondi» accanto ad «Annulla»
    // nell'overlay per-sede). È il passo che mancava: prima scriveva e basta.
    try {
      await pubblica(root);
      await paginaAperta.waitForTimeout(2500);
      await paginaAperta
        .screenshot({ path: path.join(SCREENSHOT_DIR, "esegui-pubblicata.png") })
        .catch(() => {});
      esito({
        ok: true,
        stato: "pubblicata",
        trovata: true,
        scritto: true,
        gruppo: dove,
        messaggio: `Pubblicata su Google in ${dove}.`,
      });
    } catch (err) {
      esito({
        ok: false,
        stato: "pubblica-errore",
        trovata: true,
        gruppo: dove,
        messaggio: `Trovata e scritta, ma l'invio è fallito: ${err instanceof Error ? err.message : String(err)}`,
      });
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
