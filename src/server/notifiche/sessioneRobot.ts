import { isGraphConfigured, sendMail } from "@/server/graph/client";
import { emailAdminAttivi } from "@/server/auth/utenti";
import { scritturaConsentita } from "@/server/settings";
import { C, esc, involucro, paragrafo } from "./stile";

// L'avviso all'amministratore quando Google chiude la sessione del robot.
//
// È un guasto del SISTEMA, non di una recensione: finché qualcuno non rifà
// l'accesso sul server il pilota non pubblica niente, né le positive né le
// risposte del customer care, e le recensioni aspettano in coda. Una mail per
// caduta, non una a giro: il conto lo tiene il pilota.
//
// Conta soprattutto da quando il pilota lavora anche sabato e domenica, con
// l'ufficio vuoto (decisione di Mario, 22/9/2026).
//
// È BEST-EFFORT come l'avviso di segnalazione: non solleva mai.

const dataOra = new Intl.DateTimeFormat("it-IT", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Rome",
});

function corpoHtml(messaggioRobot: string): string {
  return `
        <tr><td style="padding:14px 24px 0;font-size:14px;line-height:1.55">
          ${paragrafo(
            "Il robot doveva pubblicare una risposta su Google, ma Google gli ha chiesto di rifare l'accesso. " +
              "Finché qualcuno non lo rifà, il pilota non pubblica niente: né le positive né le risposte del customer care.\n\n" +
              "Le recensioni NON si perdono e NON passano in Supervisione: restano in coda e ripartono da sole al primo giro dopo l'accesso. " +
              "Gli inoltri al customer care intanto continuano, perché non usano il robot.",
          )}
        </td></tr>

        <tr><td style="padding:16px 24px 0">
          <div style="font-size:12px;color:${C.testoSoft};margin-bottom:6px">Cosa fare, sul PC-server in ufficio</div>
          <div style="border-left:3px solid ${C.rosso};background:#fdf3f4;border-radius:0 10px 10px 0;padding:14px 16px;font-size:14px;line-height:1.55">
            Nella cartella del portale lancia <strong>npm run robot:sessione</strong>: si apre Chrome, fai l'accesso a Google
            (email, password, codice) e, quando vedi le recensioni, torna nel terminale e premi INVIO.
          </div>
        </td></tr>

        <tr><td style="padding:12px 24px 0;font-size:12px;color:${C.testoSoft}">
          Messaggio del robot: ${esc(messaggioRobot)}
        </td></tr>`;
}

/** Manda l'avviso agli admin. Non solleva mai: ritorna cosa è successo, per i log. */
export async function avvisaAdminSessioneGoogleScaduta(opts: {
  messaggioRobot: string;
  link: string;
}): Promise<{ inviata: boolean; motivo: string }> {
  try {
    if (!(await scritturaConsentita())) {
      return { inviata: false, motivo: "modalità simulazione: nessuna mail inviata" };
    }
    if (!(await isGraphConfigured())) {
      return { inviata: false, motivo: "Microsoft Graph non configurato" };
    }
    const destinatari = await emailAdminAttivi();
    if (destinatari.length === 0) {
      return { inviata: false, motivo: "nessun admin attivo ha un indirizzo email nel profilo" };
    }

    await sendMail({
      destinatari,
      oggetto: "[Robot] Google ha chiuso la sessione: le pubblicazioni sono ferme",
      html: involucro({
        accento: C.rosso,
        etichetta: "Robot fermo",
        titolo: "Il robot non è più collegato a Google",
        sottotitolo: `Il pilota se n'è accorto il ${esc(dataOra.format(new Date()))}`,
        corpoHtml: corpoHtml(opts.messaggioRobot),
        pulsante: {
          testo: "Apri Supervisione",
          href: opts.link,
          nota: "Nella riga del pilota vedi quando ha provato l'ultima volta.",
        },
        piePagina:
          "Messaggio automatico di Galdieri Reviews. Ne arriva uno solo per ogni volta che la sessione cade: il prossimo solo dopo che il robot sarà tornato a pubblicare.",
      }),
    });
    return { inviata: true, motivo: destinatari.join(", ") };
  } catch (e) {
    return { inviata: false, motivo: e instanceof Error ? e.message : "errore sconosciuto" };
  }
}
