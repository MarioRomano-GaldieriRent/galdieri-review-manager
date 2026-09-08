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

// --- Riconoscimento del NOME italiano (ripiego quando manca il testo) -----
//
// Le 5★ senza commento non hanno nessun testo da cui riconoscere la lingua:
// prima finivano SEMPRE in italiano ("Grazie."), a prescindere da chi avesse
// scritto. Ma le sedi sono per lo più aeroportuali, quindi il grosso di quelle
// recensioni è di clienti stranieri. Qui si guarda il NOME: italiano
// riconoscibile -> italiano; inglese, spagnolo, tedesco o comunque un nome che
// "non mostra una nazionalità italiana" -> inglese. Vale SOLO come ultimo
// ripiego, dopo Azure e dopo l'euristica sul testo: vedi linguaRisposta.
//
// Non è un elenco esaustivo (impossibile: sono nomi di persone), ma copre i
// prenomi e i cognomi italiani più diffusi. Un nome italiano raro può non
// essere riconosciuto — in quel caso, per un cliente straniero della porta
// accanto, si preferisce sbagliare verso l'inglese piuttosto che verso
// l'italiano: è la scelta esplicita chiesta per queste sedi.

/** Prenomi italiani molto diffusi, minuscoli e senza accenti. */
const PRENOMI_IT = new Set([
  "marco", "luca", "andrea", "matteo", "alessandro", "lorenzo", "francesco",
  "giuseppe", "giovanni", "antonio", "roberto", "paolo", "stefano", "fabio",
  "massimo", "claudio", "sergio", "vincenzo", "salvatore", "domenico",
  "carlo", "alberto", "enrico", "vittorio", "renato", "bruno", "aldo",
  "dario", "mario", "pietro", "davide", "simone", "federico", "riccardo",
  "nicola", "gabriele", "emanuele", "tommaso", "leonardo", "filippo",
  "michele", "daniele", "cristian", "cristiano", "valerio", "giulio",
  "gianluca", "gianmarco", "gianni", "franco", "giorgio", "umberto",
  "ettore", "ernesto", "guido", "ivan", "luigi", "marino", "nino", "oscar",
  "pasquale", "raffaele", "remo", "rocco", "rolando", "romano", "samuele",
  "silvio", "tiziano", "ugo", "walter", "edoardo", "raimondo", "amedeo",
  "maria", "anna", "laura", "sara", "elena", "chiara", "valentina",
  "silvia", "paola", "roberta", "cristina", "stefania", "alessandra",
  "martina", "ilaria", "federica", "michela", "barbara", "daniela",
  "simona", "rosa", "angela", "carla", "giulia", "francesca", "giorgia",
  "giada", "alice", "beatrice", "camilla", "carolina", "caterina",
  "cecilia", "claudia", "cristiana", "debora", "donatella", "elisa",
  "elisabetta", "emanuela", "emma", "eleonora", "fabiola", "fiorella",
  "flavia", "franca", "gabriella", "gaia", "gemma", "ginevra", "giovanna",
  "gloria", "grazia", "greta", "ida", "irene", "irma", "isabella", "ivana",
  "letizia", "lidia", "liliana", "linda", "lorena", "loredana", "lucia",
  "luciana", "luisa", "manuela", "marcella", "margherita", "marina",
  "marisa", "marta", "monica", "nadia", "natalia", "nicoletta", "noemi",
  "ombretta", "ornella", "patrizia", "piera", "raffaella", "rita",
  "rossana", "sabrina", "sandra", "serena", "sofia", "sonia", "teresa",
  "tiziana", "vanessa", "vera", "veronica", "viola", "virginia", "vittoria",
  "ambra", "azzurra", "bianca", "celeste", "diletta", "ornella",
]);

/** Cognomi italiani molto diffusi, minuscoli e senza accenti. */
const COGNOMI_IT = new Set([
  "rossi", "russo", "ferrari", "esposito", "bianchi", "romano", "colombo",
  "ricci", "marino", "greco", "bruno", "gallo", "conti", "costa",
  "giordano", "mancini", "rizzo", "lombardi", "moretti", "barbieri",
  "fontana", "santoro", "mariani", "rinaldi", "caruso", "ferrara", "galli",
  "martini", "leone", "longo", "gentile", "martinelli", "vitale",
  "lombardo", "serra", "coppola", "marchetti", "parisi", "villa", "conte",
  "ferraro", "ferro", "sartori", "monti", "bianco", "piras", "molinari",
  "rossetti", "caputo", "sanna", "marchi", "pellegrini", "palumbo",
  "cattaneo", "testa", "grasso", "amato", "guerra", "farina", "rosso",
  "basile", "silvestri", "riva", "bernardi", "fabbri", "valentini",
  "messina", "fiore", "orlando", "sala", "neri", "costantini", "vitali",
  "napolitano", "bianchini", "morelli", "monaco", "rosa", "palmieri",
  "gatti", "gasparini", "benedetti", "ruggiero", "ferretti", "pagano",
  "guidi", "negri", "milani", "bassi", "donati", "brambilla", "mazza",
  "spina", "sorrentino", "landi", "bianconi", "montanari", "rossini",
  "girardi", "tonelli", "fantini", "benini", "moroni", "capelli", "tortora",
  "pace", "celentano", "gambino", "savarese", "cardinale", "bellini",
  "magni", "pucci", "montanaro", "catalano", "terranova", "bellucci",
  "casale", "spadaro", "gulli", "alfano", "siciliano", "calabrese",
  "arcuri", "sardo", "siracusa", "romeo", "pagliaro", "galdieri",
  // Con l'apostrofo, come parola singola dopo lo split sugli spazi.
  "d'amico", "d'angelo", "d'agostino", "d'ambrosio", "d'onofrio",
  "d'antonio", "d'errico", "d'alessandro", "d'ancona", "d'auria",
]);

/**
 * Cognomi composti da più parole (De/Di/Del/Della/Lo/La ...): si controllano
 * come frase intera, non parola per parola — "de" e "luca" da soli darebbero
 * troppi falsi positivi/negativi.
 */
const COGNOMI_IT_COMPOSTI = new Set([
  "de luca", "de angelis", "de santis", "de rosa", "de martino",
  "de filippis", "de vito", "de simone", "di stefano", "di marco",
  "di caprio", "del vecchio", "della valle", "dalla costa", "la rocca",
  "lo bianco",
]);

/** Minuscolo, senza accenti: per confrontare una parola del nome con le liste. */
function paroleNormalizzate(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Apostrofi tipografici -> quello dritto: \u00abD'Amico\u00bb e \u00abD'Amico\u00bb (\u2019) sono
    // la stessa persona, e la lista sotto ne conosce solo una forma.
    .replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'")
    .toLowerCase()
    .trim();
}

/**
 * Il nome «sembra» italiano? Usato SOLO come ultimo ripiego (vedi
 * linguaRisposta) quando non c'è nessun testo da cui riconoscere la lingua.
 */
export function nomeSembraItaliano(nome: string): boolean {
  const originale = (nome ?? "").trim();
  if (!originale) return false;

  // Segni tipicamente estranei all'italiano (k, w, x, y, dieresi, ñ, ç, ...):
  // bastano da soli a escluderlo, anche senza riconoscere nessuna parola —
  // stessi segni di riconosciLingua, coerenza fra le due euristiche.
  if (conta(originale, SEGNI_NON_IT) > 0) return false;

  const parole = originale.split(/\s+/).map(paroleNormalizzate).filter(Boolean);
  if (parole.length === 0) return false;

  for (let i = 0; i < parole.length - 1; i++) {
    if (COGNOMI_IT_COMPOSTI.has(`${parole[i]} ${parole[i + 1]}`)) return true;
  }
  return parole.some((p) => PRENOMI_IT.has(p) || COGNOMI_IT.has(p));
}

/**
 * Lingua in cui rispondere, a due vie: italiano per gli italiani, inglese per
 * tutti gli altri. Nessuna eccezione, qualunque sia la lingua del cliente.
 *
 * Usa la lingua RILEVATA da Azure quando c'è: è la fonte più affidabile, e in
 * più risolve un tranello. Da quando le recensioni si traducono in italiano
 * per leggerle, il testo "corrente" di una recensione tedesca è ormai in
 * italiano: passarlo a riconosciLingua farebbe rispondere in italiano a tutti.
 * Perciò l'euristica di ripiego (quando Azure è spento) gira sul testo
 * ORIGINALE del cliente, mai sulla traduzione.
 *
 * Quando NEMMENO il testo dà un segnale (tipico: 5★ senza commento, o un
 * testo troppo corto/neutro) si guarda il NOME (`nomeSembraItaliano`): prima
 * un "ignoto" finiva sempre in italiano, cioè un "Grazie." anche a un cliente
 * straniero che non ha scritto nulla. Ora l'italiano è la scelta di chi il
 * nome ce l'ha riconoscibile; tutti gli altri casi (incluso il nome mancante)
 * vanno in inglese — coerente col fatto che le sedi sono per lo più
 * aeroportuali e il grosso dei clienti è straniero.
 *
 *   linguaRilevata = "it"           -> italiano
 *   linguaRilevata = "de","fr",...  -> inglese
 *   Azure spento, testo riconoscibile -> quello che dice il testo
 *   Azure spento, testo "ignoto"      -> nome italiano riconosciuto ? italiano : inglese
 */
export function linguaRisposta(
  linguaRilevata: string,
  testoOriginale: string,
  nomeCliente = "",
): Lingua {
  const codice = (linguaRilevata ?? "").trim().toLowerCase();
  if (codice) return codice === "it" ? "it" : "altra";
  const dalTesto = riconosciLingua(testoOriginale);
  if (dalTesto !== "ignota") return dalTesto;
  return nomeSembraItaliano(nomeCliente) ? "it" : "altra";
}

/**
 * Sceglie il testo giusto fra la versione italiana e quella inglese.
 * Quando la lingua non è riconoscibile si usa l'italiano: è la lingua di casa
 * e la maggioranza delle recensioni.
 *
 * Il ripiego all'italiano per "altra" senza testo inglese è una rete di
 * sicurezza che NON deve mai scattare: ogni regola di risposta porta entrambe
 * le lingue (vedi rules.ts). Se scattasse, un cliente straniero riceverebbe
 * italiano, contro la regola.
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
