// Tipi del motore automazioni.
//
// Una REGOLA associa una CONDIZIONE (quante stelle, con o senza testo) a una
// sequenza di AZIONI. Ogni azione è un nodo del flusso: ha un servizio di
// destinazione (Freshdesk, Google, email) e dichiara se SCRIVE o solo LEGGE.
//
// Le azioni di sola lettura girano davvero anche in simulazione: è così che la
// simulazione riesce a dire "questo è il ticket #56450 che avrei chiuso".
// Le azioni di scrittura in simulazione non partono mai: producono solo la
// descrizione esatta della chiamata che sarebbe stata fatta.

export type Servizio = "freshdesk" | "google" | "email" | "sistema";

export const TIPI_AZIONE = [
  "freshdesk.trovaTicket",
  "freshdesk.classifica",
  "freshdesk.tag",
  "freshdesk.assegna",
  "freshdesk.stato",
  "google.rispondi",
  "email.inoltra",
  "sistema.attendiRisposta",
] as const;

export type TipoAzione = (typeof TIPI_AZIONE)[number];

export type ParametroAzione = {
  nome: string;
  etichetta: string;
  multilinea?: boolean;
  aiuto?: string;
};

export type DescrizioneAzione = {
  servizio: Servizio;
  titolo: string;
  descrizione: string;
  /** true = modifica qualcosa fuori da qui. In simulazione non viene mai eseguita. */
  scrittura: boolean;
  parametri: ParametroAzione[];
};

/**
 * Catalogo dei nodi disponibili. I valori riflettono come le recensioni sono
 * gestite oggi davvero su Freshdesk (rilevato dai ticket esistenti).
 */
export const CATALOGO: Record<TipoAzione, DescrizioneAzione> = {
  "freshdesk.trovaTicket": {
    servizio: "freshdesk",
    titolo: "Trova il ticket",
    descrizione:
      "Cerca su Freshdesk il ticket aperto da questa recensione, confrontando oggetto e sede. È il primo nodo di ogni flusso: senza ticket gli altri nodi non hanno un bersaglio.",
    scrittura: false,
    parametri: [],
  },
  "freshdesk.classifica": {
    servizio: "freshdesk",
    titolo: "Classifica il ticket",
    descrizione:
      "Imposta tipo ticket e i tre livelli del campo TipoRichiesta-UCM, come fa oggi l'Ufficio Marketing.",
    scrittura: true,
    parametri: [
      { nome: "tipo", etichetta: "Tipo ticket", aiuto: "es. Recensioni clienti GMB" },
      { nome: "specifica1", etichetta: "Valutazione", aiuto: "positiva | negativa" },
      { nome: "specifica2", etichetta: "Stelle", aiuto: "es. 5 stelle" },
    ],
  },
  "freshdesk.tag": {
    servizio: "freshdesk",
    titolo: "Applica i tag",
    descrizione:
      "Aggiunge i tag al ticket. {sede} viene sostituito con il tag della sede ricavato dall'oggetto.",
    scrittura: true,
    parametri: [
      { nome: "tag", etichetta: "Tag separati da virgola", aiuto: "es. {sede}, personale" },
    ],
  },
  "freshdesk.assegna": {
    servizio: "freshdesk",
    titolo: "Assegna a un agente",
    descrizione: "Cambia l'agente responsabile del ticket.",
    scrittura: true,
    parametri: [{ nome: "agenteId", etichetta: "Id agente Freshdesk" }],
  },
  "freshdesk.stato": {
    servizio: "freshdesk",
    titolo: "Cambia stato",
    descrizione: "Porta il ticket allo stato indicato: 2 Aperto, 3 In attesa, 4 Risolto, 5 Chiuso.",
    scrittura: true,
    parametri: [{ nome: "stato", etichetta: "Stato", aiuto: "2 | 3 | 4 | 5" }],
  },
  "google.rispondi": {
    servizio: "google",
    titolo: "Rispondi su Google",
    descrizione:
      "Pubblica la risposta pubblica sotto la recensione. Usa l'API Business Profile, che richiede l'approvazione della quota da parte di Google.",
    scrittura: true,
    parametri: [
      {
        nome: "testo",
        etichetta: "Testo della risposta",
        multilinea: true,
        aiuto: "Segnaposto disponibili: {nome} {sede} {stelle}",
      },
    ],
  },
  "email.inoltra": {
    servizio: "email",
    titolo: "Inoltra l'email",
    descrizione:
      "Inoltra il messaggio originale della recensione a un'altra casella, con un testo di accompagnamento.",
    scrittura: true,
    parametri: [
      { nome: "a", etichetta: "Destinatario" },
      { nome: "testo", etichetta: "Testo di accompagnamento", multilinea: true },
    ],
  },
  "sistema.attendiRisposta": {
    servizio: "sistema",
    titolo: "Attendi la risposta",
    descrizione:
      "Il flusso si ferma qui e resta in attesa che il collega risponda all'inoltro. Alla risposta riparte il flusso di ritorno: risposta su Google e chiusura del ticket.",
    scrittura: false,
    parametri: [{ nome: "da", etichetta: "Si attende risposta da" }],
  },
};

// ------------------------------------------------------------------ regole

export type PresenzaTesto = "con" | "senza" | "qualsiasi";

export type Condizione = {
  /** Punteggi a cui si applica la regola. */
  stelle: number[];
  testo: PresenzaTesto;
};

export type Azione = {
  id: string;
  tipo: TipoAzione;
  parametri: Record<string, string>;
};

export type Regola = {
  id: string;
  nome: string;
  attiva: boolean;
  condizione: Condizione;
  azioni: Azione[];
};

/** Vero se la recensione ricade nella condizione della regola. */
export function condizioneSoddisfatta(
  c: Condizione,
  stelle: number | null,
  conTesto: boolean,
): boolean {
  if (stelle === null || !c.stelle.includes(stelle)) return false;
  if (c.testo === "con") return conTesto;
  if (c.testo === "senza") return !conTesto;
  return true;
}

// --------------------------------------------------------------- esecuzione

export type StatoNodo = "ok" | "errore" | "saltato" | "simulato";

export type EsitoNodo = {
  azioneId: string;
  tipo: TipoAzione;
  servizio: Servizio;
  titolo: string;
  stato: StatoNodo;
  messaggio: string;
  /** Chiamata che è stata fatta, o che sarebbe stata fatta in modalità reale. */
  chiamata: { metodo: string; url: string; corpo?: string } | null;
  durataMs: number;
};

export type Esecuzione = {
  id: string;
  quando: string;
  modo: "simulazione" | "reale";
  regolaId: string;
  regolaNome: string;
  recensione: {
    chiave: string;
    nome: string;
    stelle: number | null;
    sede: string;
    testo: string;
  };
  nodi: EsitoNodo[];
  esito: "ok" | "errore";
};
