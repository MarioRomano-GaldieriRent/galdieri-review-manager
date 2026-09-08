import { coll } from "@/server/db/connessione";
import { isGraphConfigured, sendMail } from "@/server/graph/client";
import { scritturaConsentita } from "@/server/settings";
import type { OperatoreDoc } from "@/server/auth/utenti";
import type { Recensione } from "@/server/reviews/load";

// L'avviso all'amministratore quando un operatore preme il «?» su una
// recensione che non riesce a gestire. Porta tutto quello che serve per
// decidere senza aprire il gestionale — punteggio, sede, data, testo del
// cliente e la nota di chi ha segnalato — più il tasto che apre Supervisione.
//
// È BEST-EFFORT: chi la chiama non deve mai far fallire la segnalazione se la
// mail non parte. La segnalazione vive nel database e resta comunque nel
// pannello: la mail è un avviso, non il canale.

/** Colori presi da globals.css: la mail deve somigliare al portale. */
const C = {
  blu: "#0071e3",
  rosso: "#e30613",
  sfondo: "#f5f5f7",
  superficie: "#ffffff",
  superficieAlt: "#f0f0f3",
  bordo: "#e4e4e9",
  testo: "#1d1d1f",
  testoSoft: "#636366",
  oro: "#b8730a",
};

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Il testo del cliente va a capo come l'ha scritto lui, senza HTML suo. */
function paragrafo(s: string): string {
  return esc(s).replace(/\r?\n/g, "<br>");
}

function stelle(n: number | null): string {
  if (n === null) return `<span style="color:${C.testoSoft}">senza punteggio</span>`;
  return `<span style="color:${C.oro};font-size:15px;letter-spacing:1px">${"★".repeat(n)}<span style="color:${C.bordo}">${"★".repeat(5 - n)}</span></span>`;
}

const dataOra = new Intl.DateTimeFormat("it-IT", { dateStyle: "long", timeStyle: "short" });

/** Gli admin attivi con un indirizzo: sono loro a ricevere l'avviso. */
async function destinatariAdmin(): Promise<string[]> {
  const righe = (await (await coll<OperatoreDoc>("operatori"))
    .find({ tipo: "persona", attivo: true, ruolo: "admin" })
    .toArray()) as OperatoreDoc[];
  return righe.map((o) => (o.email ?? "").trim()).filter((e) => e.includes("@"));
}

function riga(etichetta: string, valore: string): string {
  return `
    <tr>
      <td style="padding:6px 0;color:${C.testoSoft};font-size:13px;white-space:nowrap;vertical-align:top">${esc(etichetta)}</td>
      <td style="padding:6px 0 6px 14px;color:${C.testo};font-size:14px;vertical-align:top">${valore}</td>
    </tr>`;
}

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

  return `<!doctype html>
<html lang="it">
<body style="margin:0;padding:0;background:${C.sfondo};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.testo}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.sfondo};padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.superficie};border:1px solid ${C.bordo};border-radius:14px;overflow:hidden">

        <tr><td style="border-top:4px solid ${C.rosso};padding:20px 24px 4px">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.rosso};font-weight:700">Segnalazione</div>
          <div style="font-size:19px;font-weight:600;margin-top:6px">Una recensione ha bisogno di te</div>
          <div style="font-size:13px;color:${C.testoSoft};margin-top:4px">
            ${esc(daChi)} non è riuscita a gestirla e te l'ha passata · ${esc(dataOra.format(quando))}
          </div>
        </td></tr>

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
        </td></tr>

        <tr><td style="padding:22px 24px 24px" align="center">
          <a href="${esc(link)}" style="display:inline-block;background:${C.blu};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 36px;border-radius:980px">Apri</a>
          <div style="font-size:12px;color:${C.testoSoft};margin-top:12px">
            Da lì puoi segnarla come risolta o rimetterla nella coda di ${esc(daChi)}.
          </div>
        </td></tr>

        <tr><td style="border-top:1px solid ${C.bordo};padding:14px 24px;font-size:11px;color:${C.testoSoft}">
          Messaggio automatico di GaldieriReviews. Finché la segnalazione resta aperta, la recensione non compare nella coda di chi l'ha segnalata.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
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
    const destinatari = await destinatariAdmin();
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
