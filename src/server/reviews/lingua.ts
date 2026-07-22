// Riconoscimento della lingua di una recensione, senza chiamare nessun servizio.
//
// Perché serve: le risposte seguono la lingua del cliente. Guardando come
// risponde oggi Stefania, la regola non è "rispondi nella lingua della
// recensione" ma più semplice e a due vie:
//
//   recensione in italiano  -> risposta in italiano   ("Gentile signor ...")
//   recensione in altra lingua -> risposta in INGLESE ("Dear Mr ...")
//
// Verificato sui casi reali: Oezi Karaca scrive in tedesco e riceve inglese,
// Madjid scrive in francese e riceve inglese, Aya von Ballestrem scrive in
// tedesco e riceve inglese. Nessuno riceve risposta in tedesco o francese.
//
// Basta quindi distinguere "italiano" da "non italiano": un compito molto più
// facile e affidabile del riconoscere la lingua esatta, e che non richiede né
// chiave né rete.

export type Lingua = "it" | "altra" | "ignota";

// Parole molto frequenti in italiano.
const PAROLE_IT =
  /\b(che|non|per|con|sono|molto|anche|questa|questo|della|dello|delle|degli|nella|nello|alla|allo|agli|dei|del|il|lo|la|gli|un|una|uno|ma|però|perché|quando|dove|come|tutto|tutti|tutte|bene|male|buono|buona|ottimo|ottima|pessimo|pessima|servizio|personale|auto|macchina|vettura|noleggio|consigliato|consiglio|disponibile|disponibilità|gentile|gentili|gentilissimo|gentilissima|veloce|rapido|rapida|efficiente|cortese|professionale|puntuale|pulita|pulito|nuova|nuovo|perfetto|perfetta|prenotazione|esperienza|consegna|ritiro|sede|prezzo|prezzi|accoglienza|ragazzi|ragazza|signorina|signor|grazie|mille|davvero|sempre|mai|già|più|meno|abbastanza|purtroppo|comunque|inoltre|infatti|quindi|siamo|abbiamo|hanno|erano|stato|stata|stati|state|ci|ha|ho|si|se|da|di|in|al|del|sul|mi|ti|ne|fa|poi|solo|ok|nulla|niente|zero|poco|pochi|molti|molte)\b/gi;

/**
 * Parole frequenti nelle altre lingue, MA solo quelle che in italiano non
 * esistono. Le sovrapposizioni vanno tolte senza pietà: "in", "la", "un",
 * "una", "con", "auto", "no", "so", "le" sono comunissime in italiano e
 * mettendole qui facevano scambiare per straniere frasi come
 * "Pablo ci ha seguito in maniera professionale".
 */
const PAROLE_ALTRE =
  /\b(the|and|was|were|very|good|great|service|staff|car|rental|would|have|had|this|that|with|from|they|there|their|because|when|where|but|not|you|your|we|our|my|is|are|be|been|being|at|on|to|of|for|as|if|yes|please|thank|thanks|el|los|las|por|para|muy|bueno|buena|servicio|coche|alquiler|les|des|du|au|aux|tres|très|bon|bonne|voiture|nous|vous|ils|elles|der|die|das|und|sehr|gut|gute|mieten|wir|sie|ich|nicht|aber|auch|ein|eine|mit|von|zu|ist|war|waren)\b/gi;

/**
 * Segni che in italiano praticamente non esistono: le lettere k, w, x, y e le
 * vocali con dieresi o altri segni stranieri. Una sola "k" in una parola come
 * "Unkomplizierte" basta a escludere l'italiano, anche quando non c'è nessuna
 * parola comune da riconoscere.
 *
 * Niente digrammi come "ch" o "gh": in italiano sono frequentissimi
 * ("anche", "laghi") e darebbero falsi allarmi.
 */
const SEGNI_NON_IT = /[äöüßñçêôûåøœæáíóúãõășțâ¿¡]|[kwxy]/gi;

const conta = (testo: string, re: RegExp) => (testo.match(re) ?? []).length;

/**
 * Riconosce se la recensione è in italiano.
 *
 * Restituisce "ignota" quando il testo è troppo corto o troppo neutro per
 * decidere: con due parole non si distingue "ottimo" da "ok", ed è più onesto
 * dirlo che tirare a indovinare.
 */
export function riconosciLingua(testo: string): Lingua {
  const t = (testo ?? "").trim();
  if (t.length < 12) return "ignota";

  const parole = t.split(/\s+/).length;
  const punteggioIt = conta(t, PAROLE_IT);
  // I segni stranieri pesano il doppio di una parola comune: sono più rari ma
  // molto più decisivi.
  const punteggioAltre = conta(t, PAROLE_ALTRE) + conta(t, SEGNI_NON_IT) * 2;

  // Nulla di riconoscibile da nessuna delle due parti: testo troppo
  // particolare (nomi propri, sigle) per decidere.
  if (punteggioIt === 0 && punteggioAltre === 0) return parole >= 6 ? "altra" : "ignota";

  if (punteggioIt > punteggioAltre) return "it";
  if (punteggioAltre > punteggioIt) return "altra";
  return "ignota";
}

/**
 * Sceglie il testo giusto fra la versione italiana e quella inglese.
 * Quando la lingua non è riconoscibile si usa l'italiano: è la lingua di casa
 * e la maggioranza delle recensioni.
 */
export function testoNellaLingua(lingua: Lingua, italiano: string, inglese: string): string {
  if (lingua === "altra" && inglese.trim()) return inglese;
  return italiano;
}

export function etichettaLingua(lingua: Lingua): string {
  if (lingua === "it") return "italiano";
  if (lingua === "altra") return "non italiano";
  return "lingua non riconoscibile";
}
