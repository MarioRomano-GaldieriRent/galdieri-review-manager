import { mkdirSync } from "fs";
import path from "path";
import {
  apriContesto,
  GRUPPI,
  pubblica,
  sessioneAttiva,
  SCREENSHOT_DIR,
  trovaRecensioneEScrivi,
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

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    if (!(await sessioneAttiva(page))) {
      esito({ ok: false, stato: "non-loggato", messaggio: "Robot non loggato su Google. Lancia: npm run robot:sessione" });
      return;
    }

    let dettaglio = "";
    for (const gr of GRUPPI) {
      await page.goto(gr.url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3000);

      const e = await trovaRecensioneEScrivi(page, job.nome, job.testo, { maxPassi: 40 });
      dettaglio = e.dettaglio;
      if (!e.trovata) continue;

      await page
        .screenshot({ path: path.join(SCREENSHOT_DIR, `esegui-${job.azione}.png`) })
        .catch(() => {});

      // "cerca": si FERMA sulla recensione (con la risposta già pronta nel
      // riquadro) e LASCIA il browser aperto: procede l'operatore. Il processo
      // resta vivo finché l'operatore non chiude la finestra (o 30 min).
      if (job.azione === "cerca") {
        esito({ ok: true, stato: "aperta", trovata: true, scritto: e.scritto, gruppo: gr.nome, messaggio: `Fermo sulla recensione di «${job.nome}» in «${gr.nome}». Procedi tu nella finestra.` });
        await new Promise<void>((res) => {
          ctx.once("close", () => res());
          setTimeout(res, 30 * 60 * 1000);
        });
        return;
      }

      if (!e.scritto) {
        esito({ ok: false, stato: "trovata-non-scritta", trovata: true, gruppo: gr.nome, messaggio: `Trovata in «${gr.nome}» ma non ho potuto scrivere: ${dettaglio}` });
        return;
      }

      if (job.azione === "test") {
        esito({ ok: true, stato: "scritta", trovata: true, scritto: true, gruppo: gr.nome, messaggio: `Trovata in «${gr.nome}» e scritto «${job.testo}». NON pubblicata (test).` });
        return;
      }

      // azione "pubblica": clicca «Pubblica risposta» solo se è abilitata.
      const abilitato = await page
        .getByRole("button", { name: /Pubblica risposta/i })
        .isEnabled()
        .catch(() => false);
      if (!abilitato) {
        esito({ ok: false, stato: "pubblica-non-abilitata", trovata: true, gruppo: gr.nome, messaggio: `Trovata in «${gr.nome}», testo scritto, ma «Pubblica risposta» non è attivo.` });
        return;
      }
      try {
        await pubblica(page);
        await page.waitForTimeout(2500);
        await page
          .screenshot({ path: path.join(SCREENSHOT_DIR, "esegui-pubblicata.png") })
          .catch(() => {});
        esito({ ok: true, stato: "pubblicata", trovata: true, scritto: true, gruppo: gr.nome, messaggio: `Pubblicata su Google in «${gr.nome}».` });
      } catch (err) {
        esito({ ok: false, stato: "pubblica-errore", trovata: true, gruppo: gr.nome, messaggio: `Trovata e scritta, ma la pubblicazione è fallita: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }

    // "cerca": anche se non l'ho trovata da solo, lascio Google APERTO così
    // l'operatore la cerca a mano nella finestra.
    if (job.azione === "cerca") {
      esito({ ok: true, stato: "aperta-non-trovata", trovata: false, messaggio: `Non ho trovato «${job.nome}» da solo: ho lasciato Google aperto, cercala tu nella finestra.` });
      await new Promise<void>((res) => {
        ctx.once("close", () => res());
        setTimeout(res, 30 * 60 * 1000);
      });
      return;
    }

    esito({ ok: false, stato: "non-trovata", trovata: false, messaggio: `«${job.nome}» non trovata nei gruppi (Point Attivi / Breve Termine). ${dettaglio}` });
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
