// Tempo: un unico posto dove si decide cosa significa "quando".
//
// Le date arrivano da Microsoft Graph in UTC. Le persone che leggono i numeri
// ragionano in ora italiana: una recensione arrivata alle 00:30 di lunedì UTC
// in Italia è arrivata alle 02:30 di lunedì d'estate, e a cavallo di mezzanotte
// il giorno cambia. Salvare solo l'UTC vorrebbe dire raggruppare per giorni
// sbagliati; salvare solo il locale vorrebbe dire perdere l'istante esatto.
// Si salvano entrambi, e la conversione avviene qui.

/** Istante di adesso in ISO-8601 UTC. È l'unico modo ammesso di dire "ora". */
export function adesso(): string {
  return new Date().toISOString();
}

/**
 * Stesso istante, letto in Europe/Rome, nel formato "YYYY-MM-DDTHH:mm:ss".
 *
 * Si usa il locale "sv-SE" perché è l'unico che Intl formatta già come
 * ISO (2026-07-22 14:05:00): evita di montare la stringa a mano pezzo per
 * pezzo, che è il posto dove nascono gli errori di zero iniziale.
 */
const FORMATO_ROMA = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function aOraItaliana(isoUtc: string): string {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return "";
  // "2026-07-22 14:05:00" -> "2026-07-22T14:05:00"
  return FORMATO_ROMA.format(d).replace(" ", "T");
}

/**
 * Settimana ISO nel formato "2026-W30".
 *
 * Non si usa strftime('%W') di SQLite: quella non è la settimana ISO (conta le
 * settimane dalla prima domenica) e sballa a cavallo d'anno. La settimana ISO
 * comincia di lunedì e la prima dell'anno è quella che contiene il giovedì.
 *
 * Prima viveva copiata identica in scripts/analisi-recensioni.ts e
 * scripts/analisi-trustpilot.ts: due copie della stessa regola sono due
 * occasioni di divergere.
 */
export function settimanaIso(iso: string): string {
  // Si converte prima in ora italiana, come fa giornoSettimana(): senza,
  // una recensione arrivata domenica alle 23:30 UTC finirebbe con data_locale
  // di lunedì e settimana ISO della domenica — due colonne della stessa riga
  // che si contraddicono, e una barra del grafico nella settimana sbagliata.
  const locale = aOraItaliana(iso);
  const d = new Date(locale ? `${locale}Z` : iso);
  if (Number.isNaN(d.getTime())) return "";

  // Si ragiona in UTC su una data "spostata" al giovedì della sua settimana:
  // è il trucco standard per far cadere l'anno nel posto giusto.
  const g = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const giorno = g.getUTCDay() || 7; // domenica = 7, non 0
  g.setUTCDate(g.getUTCDate() + 4 - giorno);

  const inizioAnno = new Date(Date.UTC(g.getUTCFullYear(), 0, 1));
  const settimana = Math.ceil(((g.getTime() - inizioAnno.getTime()) / 86400000 + 1) / 7);
  return `${g.getUTCFullYear()}-W${String(settimana).padStart(2, "0")}`;
}

/** Giorno della settimana in ora italiana: 0 = domenica, 6 = sabato. */
export function giornoSettimana(iso: string): number {
  const locale = aOraItaliana(iso);
  if (!locale) return 0;
  const d = new Date(`${locale}Z`); // il fuso è già applicato: si legge in UTC
  return Number.isNaN(d.getTime()) ? 0 : d.getUTCDay();
}

/** Differenza in ore fra due istanti ISO. null se una delle due non è leggibile. */
export function oreTra(daIso: string, aIso: string): number | null {
  const a = new Date(daIso).getTime();
  const b = new Date(aIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 3600000;
}
