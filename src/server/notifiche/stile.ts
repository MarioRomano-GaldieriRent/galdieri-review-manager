// Lo stile comune delle mail di sistema: un solo posto per i colori e per
// l'involucro (intestazione, corpo, tasto, piè di pagina), così ogni nuova
// mail somiglia alle altre e al portale senza dover ricopiare la tabella HTML
// ogni volta. Prima viveva tutto dentro notifiche/segnalazione.ts: bene finché
// c'era una mail sola, un problema appena ne è arrivata una seconda (il report
// giornaliero) — due copie della stessa tabella sono due occasioni di
// divergere silenziosamente.

/** Colori presi da globals.css: la mail deve somigliare al portale. */
export const C = {
  blu: "#0071e3",
  rosso: "#e30613",
  sfondo: "#f5f5f7",
  superficie: "#ffffff",
  superficieAlt: "#f0f0f3",
  bordo: "#e4e4e9",
  testo: "#1d1d1f",
  testoSoft: "#636366",
  oro: "#b8730a",
  verde: "#1a7f37",
} as const;

export function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Un testo scritto da una persona va a capo come l'ha scritto lei, senza HTML suo. */
export function paragrafo(s: string): string {
  return esc(s).replace(/\r?\n/g, "<br>");
}

/** Le stelle piene in oro, le vuote nel colore del bordo: leggibile anche senza immagini. */
export function stelle(n: number | null): string {
  if (n === null) return `<span style="color:${C.testoSoft}">senza punteggio</span>`;
  return `<span style="color:${C.oro};font-size:15px;letter-spacing:1px">${"★".repeat(n)}<span style="color:${C.bordo}">${"★".repeat(5 - n)}</span></span>`;
}

/** Una riga «etichetta: valore» nella tabella dei dati in testa alla mail. */
export function riga(etichetta: string, valoreHtml: string): string {
  return `
    <tr>
      <td style="padding:6px 0;color:${C.testoSoft};font-size:13px;white-space:nowrap;vertical-align:top">${esc(etichetta)}</td>
      <td style="padding:6px 0 6px 14px;color:${C.testo};font-size:14px;vertical-align:top">${valoreHtml}</td>
    </tr>`;
}

/**
 * L'involucro comune a ogni mail di sistema: barra colorata in cima,
 * etichetta di categoria, titolo, sottotitolo, il corpo (già pronto, sezione
 * per sezione), un tasto opzionale e il piè di pagina. Chi chiama scrive solo
 * il contenuto specifico della sua mail — struttura e colori restano uguali
 * dappertutto.
 */
export function involucro(opts: {
  /** Colore della barra in cima e dell'etichetta: C.rosso per un avviso, C.blu per un riepilogo. */
  accento: string;
  etichetta: string;
  titolo: string;
  sottotitolo: string;
  corpoHtml: string;
  pulsante?: { testo: string; href: string; nota?: string };
  piePagina: string;
}): string {
  const { accento, etichetta, titolo, sottotitolo, corpoHtml: corpo, pulsante, piePagina } = opts;
  return `<!doctype html>
<html lang="it">
<body style="margin:0;padding:0;background:${C.sfondo};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.testo}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.sfondo};padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.superficie};border:1px solid ${C.bordo};border-radius:14px;overflow:hidden">

        <tr><td style="border-top:4px solid ${accento};padding:20px 24px 4px">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${accento};font-weight:700">${esc(etichetta)}</div>
          <div style="font-size:19px;font-weight:600;margin-top:6px">${esc(titolo)}</div>
          <div style="font-size:13px;color:${C.testoSoft};margin-top:4px">${sottotitolo}</div>
        </td></tr>

        ${corpo}

        ${
          pulsante
            ? `<tr><td style="padding:22px 24px 24px" align="center">
          <a href="${esc(pulsante.href)}" style="display:inline-block;background:${C.blu};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 36px;border-radius:980px">${esc(pulsante.testo)}</a>
          ${pulsante.nota ? `<div style="font-size:12px;color:${C.testoSoft};margin-top:12px">${pulsante.nota}</div>` : ""}
        </td></tr>`
            : ""
        }

        <tr><td style="border-top:1px solid ${C.bordo};padding:14px 24px;font-size:11px;color:${C.testoSoft}">
          ${piePagina}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
