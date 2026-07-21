// Mappa "sede nell'oggetto dell'email" -> "tag usato su Freshdesk".
//
// Non è inventata: è stata ricavata leggendo i 225 ticket GMB esistenti e
// contando quale tag di sede è stato applicato a ciascun oggetto. Dove la
// pratica interna è incoerente si è scelto il tag più frequente:
//   "Galdieri Rent Fiumicino"  -> fco (6 volte) invece di fiumicino (2)
//   "LAMEZIA TERME"            -> lamezia terme (2) invece di lameziatermeAPT (2)

const MAPPA: Record<string, string> = {
  "galdieri rent brindisi aeroporto": "brindisi",
  "galdieri rent bari aeroporto": "bari",
  "galdieri rent capodichino": "capodichino",
  "galdieri rent fiumicino": "fco",
  "galdieri rent malpensa": "MXP",
  "galdieri rent siracusa città": "siracusa",
  "lamezia terme": "lamezia terme",
  "orio al serio milano-bergamo": "bergamo",
  "point cagliari": "cagliarielmas",
  "point catania fontarossa": "cataniaeroporto",
  "point ciampino aeroporto": "ciampino",
  "point napoli centrale": "napolicentrale",
  "point palermo punta raisi": "palermo",
  "point pisa": "pisa",
  "point rimini aeroporto": "riminiaeroporto",
  "point roma termini": "romatermini",
  "point venezia marco polo": "venezia",
  "point aereoporto bologna": "bologna",
  "point aeroporto olbia": "olbia",
  "salerno stazione": "salernostazione",
  "san giuseppe vesuviano": "san giuseppe vesuviano",
  "sede lancusi": "lancusi",
  "sede direzionale emilia romagna": "sede emilia romagna",
  "sede direzionale lombardia": "sede lombardia",
  "torino centro": "torino",
};

/** Tag Freshdesk della sede; stringa vuota se la sede non è riconosciuta. */
export function tagSede(sede: string): string {
  const k = sede.trim().toLowerCase();
  if (!k) return "";
  if (MAPPA[k]) return MAPPA[k];
  // Tolleranza sulle varianti: "Point Cagliari " o "point  cagliari".
  const norm = k.replace(/\s+/g, " ");
  for (const [chiave, tag] of Object.entries(MAPPA)) {
    if (norm === chiave || norm.includes(chiave) || chiave.includes(norm)) return tag;
  }
  return "";
}

export function sediConosciute(): { sede: string; tag: string }[] {
  return Object.entries(MAPPA).map(([sede, tag]) => ({ sede, tag }));
}

// Il tag "personale" è il più usato in assoluto (119 ticket su 225): viene messo
// quando il cliente cita esplicitamente una persona o il personale della sede.
const PAROLE_PERSONALE =
  /\b(personale|staff|impiegat|addett|ragazz|signor|operator|consulent|collega|colleghi|gentiliss|scortes|maleducat|employee|assistant|clerk|agent|lady|guy|girl|kind|rude|helpful|friendly|freundlich|amable|aimable)/i;

/** Suggerisce il tag tematico "personale" leggendo il commento. */
export function citaIlPersonale(testo: string): boolean {
  return PAROLE_PERSONALE.test(testo);
}
