import { isGraphConfigured, sendMail } from "@/server/graph/client";
import { emailAdminAttivi } from "@/server/auth/utenti";
import { scritturaConsentita } from "@/server/settings";
import type { Recensione } from "@/server/reviews/load";
import { C, esc, involucro, paragrafo, riga, stelle } from "./stile";

// L'avviso all'amministratore quando un operatore preme il «?» su una
// recensione che non riesce a gestire. Porta tutto quello che serve per
// decidere senza aprire il gestionale — punteggio, sede, data, testo del
// cliente e la nota di chi ha segnalato — più il tasto che apre Supervisione.
//
// È BEST-EFFORT: chi la chiama non deve mai far fallire la segnalazione se la
// mail non parte. La segnalazione vive nel database e resta comunque nel
// pannello: la mail è un avviso, non il canale.

const dataOra = new Intl.DateTimeFormat("it-IT", { dateStyle: "long", timeStyle: "short" });

function corpoHtml(opts: {
  r: Recensione;
  nota: string;
  daChi: string;
  quando: Date;
  link: string;
}): string {
  const { r, nota, daChi, quando, link } = opts;
  const testoCliente = (r.italiano ?? r.originale ?? "").trim();
  const originaleDiverso =
    r.originale && !r.giaItaliano && r.originale.trim() !== testoCliente ? r.originale.trim() : "";

  const corpo = `
        <tr><td style="padding:14px 24px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${riga("Cliente", `<strong>${esc(r.nome || "senza nome")}</strong>`)}
            ${riga("Punteggio", stelle(r.stelle))}
            ${riga("Sede", esc(r.sede || "—"))}
            ${riga("Recensione del", esc(dataOra.format(new Date(r.ricevutaIl))))}
          </table>
        </td></tr>

        ${
          testoCliente
            ? `<tr><td style="padding:16px 24px 0">
          <div style="font-size:12px;color:${C.testoSoft};margin-bottom:6px">Cosa ha scritto il cliente</div>
          <div style="background:${C.superficieAlt};border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.55">${paragrafo(testoCliente)}</div>
          ${
            originaleDiverso
              ? `<div style="font-size:12px;color:${C.testoSoft};margin:8px 0 0">Originale${r.lingua ? ` (${esc(r.lingua.toUpperCase())})` : ""}: ${paragrafo(originaleDiverso)}</div>`
              : ""
          }
        </td></tr>`
            : ""
        }

        <tr><td style="padding:16px 24px 0">
          <div style="font-size:12px;color:${C.testoSoft};margin-bottom:6px">Il problema segnalato</div>
          <div style="border-left:3px solid ${C.rosso};background:#fdf3f4;border-radius:0 10px 10px 0;padding:14px 16px;font-size:14px;line-height:1.55">${paragrafo(nota)}</div>
        </td></tr>`;

  return involucro({
    accento: C.rosso,
    etichetta: "Segnalazione",
    titolo: "Una recensione ha bisogno di te",
    sottotitolo: `${esc(daChi)} non è riuscita a gestirla e te l'ha passata · ${esc(dataOra.format(quando))}`,
    corpoHtml: corpo,
    pulsante: {
      testo: "Apri",
      href: link,
      nota: `Da lì puoi segnarla come risolta o rimetterla nella coda di ${esc(daChi)}.`,
    },
    piePagina:
      "Messaggio automatico di Galdieri Reviews. Finché la segnalazione resta aperta, la recensione non compare nella coda di chi l'ha segnalata.",
  });
}

/**
 * Manda l'avviso agli admin. Non solleva mai: ritorna cosa è successo, così
 * chi chiama può scriverlo nei log senza rischiare di rompere la segnalazione.
 */
export async function avvisaAdminDiSegnalazione(opts: {
  recensione: Recensione;
  nota: string;
  daChi: string;
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

    const r = opts.recensione;
    const oggetto = `[Segnalazione] ${r.nome || "recensione"} · ${r.stelle ?? "?"}★${r.sede ? ` · ${r.sede}` : ""}`;
    await sendMail({
      destinatari,
      oggetto,
      html: corpoHtml({ r, nota: opts.nota, daChi: opts.daChi, quando: new Date(), link: opts.link }),
    });
    return { inviata: true, motivo: destinatari.join(", ") };
  } catch (e) {
    return { inviata: false, motivo: e instanceof Error ? e.message : "errore sconosciuto" };
  }
}
