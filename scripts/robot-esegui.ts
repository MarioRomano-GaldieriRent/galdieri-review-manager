import { mkdirSync } from "fs";
import path from "path";
import {
  apriContesto,
  cercaNeiGruppiPerPagina,
  pubblica,
  sessioneAttiva,
  SCREENSHOT_DIR,
} from "@/server/robot/google";

// Runner NON interattivo del robot, avviato dai bottoni della card (▶ Play /
// 🔍 Test Google). Il lavoro arriva nell'env ROBOT_JOB come JSON:
//
//   { "azione": "test" | "pubblica", "nome": "...", "testo": "Grazie." }
//
//   test     → trova la recensione nei gruppi, scrive il testo e SI FERMA.
//   pubblica → trova, scrive e clicca «Pubblica risposta» (reale su Google).
//
// Stampa UNA riga  __ESITO__ {json}  e chiude. Nessuna attesa di INVIO: è pensato
// per essere avviato/atteso da un'azione del server.

type Job = { azione: "test" | "pubblica" | "cerca"; nome: string; testo: string };
const AZIONI = ["test", "pubblica", "cerca"] as const;

function leggiJob(): Job {
  const raw = process.env.ROBOT_JOB || process.argv[2] || "";
  const j = JSON.parse(raw) as Partial<Job>;
  if (!j.nome || !j.azione || !(AZIONI as readonly string[]).includes(j.azione)) {
    throw new Error("ROBOT_JOB non valido");
  }
  return { azione: j.azione, nome: j.nome.trim(), testo: (j.testo || "Grazie.").trim() };
}

function esito(o: Record<string, unknown>): void {
  console.log("__ESITO__ " + JSON.stringify(o));
}

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

    // Ricerca IN AMPIEZZA: pagina 1 di tutti i gruppi, poi pagina 2 di tutti, ecc.
    const ric = await cercaNeiGruppiPerPagina(ctx, job.nome, job.testo, { maxPagine: 5 });

    if (!ric.trovata || !ric.page) {
      // "cerca": anche se non l'ho trovata da solo, lascio Google APERTO così
      // l'operatore la cerca a mano nella finestra.
      if (job.azione === "cerca") {
        esito({ ok: true, stato: "aperta-non-trovata", trovata: false, messaggio: `Non ho trovato «${job.nome}» da solo: ho lasciato Google aperto, cercala tu nella finestra.` });
        await attendiChiusura();
        return;
      }
      esito({ ok: false, stato: "non-trovata", trovata: false, messaggio: `«${job.nome}» non trovata nei gruppi. ${ric.dettaglio}` });
      return;
    }

    const page = ric.page;
    const gruppo = ric.gruppo ?? "";
    await page
      .screenshot({ path: path.join(SCREENSHOT_DIR, `esegui-${job.azione}.png`) })
      .catch(() => {});

    // "cerca": si FERMA sulla recensione (con la risposta già pronta nel
    // riquadro) e LASCIA il browser aperto: procede l'operatore.
    if (job.azione === "cerca") {
      esito({ ok: true, stato: "aperta", trovata: true, scritto: ric.scritto, gruppo, messaggio: `Fermo sulla recensione di «${job.nome}» in «${gruppo}». Procedi tu nella finestra.` });
      await attendiChiusura();
      return;
    }

    if (!ric.scritto) {
      esito({ ok: false, stato: "trovata-non-scritta", trovata: true, gruppo, messaggio: `Trovata in «${gruppo}» ma non ho potuto scrivere: ${ric.dettaglio}` });
      return;
    }

    if (job.azione === "test") {
      esito({ ok: true, stato: "scritta", trovata: true, scritto: true, gruppo, messaggio: `Trovata in «${gruppo}» e scritto «${job.testo}». NON pubblicata (test).` });
      return;
    }

    // azione "pubblica": clicca «Pubblica risposta» solo se è abilitata.
    const abilitato = await page
      .getByRole("button", { name: /Pubblica risposta/i })
      .isEnabled()
      .catch(() => false);
    if (!abilitato) {
      esito({ ok: false, stato: "pubblica-non-abilitata", trovata: true, gruppo, messaggio: `Trovata in «${gruppo}», testo scritto, ma «Pubblica risposta» non è attivo.` });
      return;
    }
    try {
      await pubblica(page);
      await page.waitForTimeout(2500);
      await page
        .screenshot({ path: path.join(SCREENSHOT_DIR, "esegui-pubblicata.png") })
        .catch(() => {});
      esito({ ok: true, stato: "pubblicata", trovata: true, scritto: true, gruppo, messaggio: `Pubblicata su Google in «${gruppo}».` });
    } catch (err) {
      esito({ ok: false, stato: "pubblica-errore", trovata: true, gruppo, messaggio: `Trovata e scritta, ma la pubblicazione è fallita: ${err instanceof Error ? err.message : String(err)}` });
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
