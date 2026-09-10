import { coll } from "@/server/db/connessione";
import { isGraphConfigured, sendMail } from "@/server/graph/client";
import { emailAdminAttivi } from "@/server/auth/utenti";
import { scritturaConsentita } from "@/server/settings";
import { gestiteNelGiorno, type GestiteNelGiorno } from "@/server/statistiche/query";
import { aOraItaliana, oraLocaleDiOggi } from "@/server/tempo";
import { C, esc, involucro, stelle } from "./stile";

// Il report che arriva ogni pomeriggio agli admin: quante recensioni sono
// state gestite oggi dalle 9:00 alle 18:00, dal portale e dalla posta, con la
// spaccatura per punteggio. È la fotografia di Supervisione (vedi
// gestiteNelGiorno) mandata per mail invece che aperta a mano.
//
// Il MITTENTE è la casella "posta monitorata" di Impostazioni (activeMailbox,
// oggi stefania.maffeo@galdierirent.it): sendMail senza `mailbox` usa sempre
// quella — è la stessa scelta già fatta per l'avviso di segnalazione, e vuol
// dire che cambiare la casella monitorata cambia da sé anche il mittente di
// QUESTA mail. Se un domani serve un mittente diverso e indipendente, va
// aggiunta una casella dedicata: oggi non c'è, e riusare quella che già
// funziona evita di dover verificare nuovi permessi Graph per niente.

const dataLunga = new Intl.DateTimeFormat("it-IT", { dateStyle: "full" });
const oraBreve = new Intl.DateTimeFormat("it-IT", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Rome",
});

export type FinestraReport = { dal: Date; al: Date };

/** La finestra di oggi: dalle 9:00 alle 18:00, ora italiana. */
export function finestraOggi(ora: Date = new Date()): FinestraReport {
  return { dal: oraLocaleDiOggi(ora, 9, 0), al: oraLocaleDiOggi(ora, 18, 0) };
}

/** "2026-09-10": la chiave del giorno italiano, per non spedire due volte lo stesso report. */
function chiaveGiorno(ora: Date): string {
  return aOraItaliana(ora.toISOString()).slice(0, 10);
}

/** L'indirizzo del portale per il tasto nella mail. Niente `headers()`: qui non c'è una richiesta, è un cron. */
function indirizzoApp(): string {
  const forzato = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  return forzato || "http://localhost:4000";
}

function corpoHtml(dati: GestiteNelGiorno, finestra: FinestraReport): string {
  const conPunteggio = dati.perStella.filter((r) => r.stelle !== null);
  const senzaPunteggio = dati.perStella.find((r) => r.stelle === null);

  const corpo = `
        <tr><td style="padding:18px 24px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="width:34%;padding:8px 4px">
                <div style="font-size:30px;font-weight:700">${dati.totale}</div>
                <div style="font-size:12px;color:${C.testoSoft}">gestite in tutto</div>
              </td>
              <td align="center" style="width:33%;padding:8px 4px;border-left:1px solid ${C.bordo}">
                <div style="font-size:22px;font-weight:700;color:${C.blu}">${dati.dalPortale}</div>
                <div style="font-size:12px;color:${C.testoSoft}">dal portale</div>
              </td>
              <td align="center" style="width:33%;padding:8px 4px;border-left:1px solid ${C.bordo}">
                <div style="font-size:22px;font-weight:700">${dati.dallaPosta}</div>
                <div style="font-size:12px;color:${C.testoSoft}">dalla posta</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:22px 24px 0">
          <div style="font-size:12px;color:${C.testoSoft};margin-bottom:8px">Per punteggio</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.bordo}">
            ${conPunteggio
              .map(
                (r) => `
            <tr style="border-bottom:1px solid ${C.bordo}">
              <td style="padding:9px 0">${stelle(r.stelle)}</td>
              <td align="right" style="padding:9px 0;font-size:15px;font-weight:600">${r.conteggio}</td>
            </tr>`,
              )
              .join("")}
            ${
              senzaPunteggio && senzaPunteggio.conteggio > 0
                ? `
            <tr>
              <td style="padding:9px 0;color:${C.testoSoft};font-size:13px">senza punteggio</td>
              <td align="right" style="padding:9px 0;font-size:15px;font-weight:600">${senzaPunteggio.conteggio}</td>
            </tr>`
                : ""
            }
          </table>
        </td></tr>`;

  return involucro({
    accento: C.blu,
    etichetta: "Report giornaliero",
    titolo: "Le recensioni gestite oggi",
    sottotitolo: `Dalle ${oraBreve.format(finestra.dal)} alle ${oraBreve.format(finestra.al)} · ${esc(dataLunga.format(finestra.al))}`,
    corpoHtml: corpo,
    pulsante: { testo: "Apri", href: `${indirizzoApp()}/supervisione` },
    piePagina:
      "Messaggio automatico di Galdieri Reviews, ogni giorno alle 18:00. «Dal portale» sono le risposte pubblicate da questo sito; " +
      "«dalla posta» sono le recensioni gestite scrivendo dalla casella senza passare di qui — vi rientra anche il semplice " +
      "inoltro al customer care, non solo la risposta finale al cliente.",
  });
}

export type EsitoReport = { inviata: boolean; motivo: string };

/**
 * Manda il report agli admin. Non solleva mai: ritorna cosa è successo, così
 * chi lancia lo script (un cron) lo scrive nei log senza far fallire nulla.
 *
 * Guardia contro il doppio invio: una riga per giorno in `report_giornaliero`.
 * Se il cron scatta due volte (un riavvio, un lancio a mano per errore) il
 * secondo tentativo trova la riga già segnata «inviato» ed esce senza
 * rimandare la mail — lo stesso principio della guardia sulle segnalazioni,
 * qui più semplice perché il trigger è uno solo al giorno, non un clic
 * ripetibile da chiunque. `forza: true` scavalca la guardia, per un reinvio
 * voluto (es. dopo aver corretto un problema).
 */
export async function inviaReportGiornaliero(
  opts: { ora?: Date; forza?: boolean } = {},
): Promise<EsitoReport> {
  const ora = opts.ora ?? new Date();
  const chiave = chiaveGiorno(ora);

  if (!opts.forza) {
    const gia = (await (await coll("report_giornaliero")).findOne({ _id: chiave, stato: "inviato" })) as {
      inviatoIl?: Date;
    } | null;
    if (gia) {
      return {
        inviata: false,
        motivo: `già inviato oggi (${chiave})${gia.inviatoIl ? ` alle ${oraBreve.format(gia.inviatoIl)}` : ""}: usa forza per rimandarlo`,
      };
    }
  }

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

  const finestra = finestraOggi(ora);
  const dati = await gestiteNelGiorno(finestra.dal, finestra.al);
  const oggetto = `Report recensioni · ${dati.totale} gestite oggi`;

  try {
    await sendMail({ destinatari, oggetto, html: corpoHtml(dati, finestra) });
  } catch (e) {
    return { inviata: false, motivo: e instanceof Error ? e.message : "errore sconosciuto" };
  }

  await (await coll("report_giornaliero")).updateOne(
    { _id: chiave },
    { $set: { stato: "inviato", inviatoIl: new Date(), destinatari, ...dati } },
    { upsert: true },
  );
  return { inviata: true, motivo: destinatari.join(", ") };
}
