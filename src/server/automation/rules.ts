import { leggiRegole, scriviRegole, type Origine } from "@/server/db/regole";
import type { Azione, Regola, TipoAzione } from "./types";

// Le regole vivono nel database, come le impostazioni. Ogni salvataggio lascia
// anche una versione immutabile: vedi src/server/db/regole.ts.

// Valori rilevati dai ticket reali (vedi commenti in sedi.ts):
//   gruppo Customer Care        80000162477   (263 ticket recensione su 263)
//   Ufficio Marketing           80108775423   lavora le recensioni positive
//   Cherubina Panico            80128977810   riceve le negative
export const AGENTE_MARKETING = "80108775423";
export const AGENTE_ESCALATION = "80128977810";
export const TIPO_TICKET_GMB = "Recensioni clienti GMB";
export const EMAIL_ESCALATION = "cherubina.panico@galdierirent.it";
/** Casella che genera i ticket: va sempre in copia, altrimenti niente ticket. */
export const EMAIL_TICKETING = "customer.care@galdierirent.it";
export const TESTO_ESCALATION = "Si trasmette per quanto di competenza.";

const azione = (id: string, tipo: TipoAzione, parametri: Record<string, string> = {}): Azione => ({
  id,
  tipo,
  parametri,
});

/**
 * Regole iniziali: ricalcano ciò che oggi viene fatto a mano.
 *
 *  5 stelle senza testo → classifica positiva, tag sede, assegna Marketing,
 *                         ringrazia su Google, risolve il ticket.
 *  5 stelle con testo   → come sopra ma con ringraziamento personalizzato e
 *                         tag "personale" quando il cliente cita qualcuno.
 *  4 stelle             → ringraziamento e ticket risolto.
 *  3 stelle             → nessuna risposta automatica: passa a Cherubina.
 *  1-2 stelle           → inoltro a Cherubina con "Si trasmette per quanto di
 *                         competenza", ticket aperto, attesa della risposta.
 *
 * ATTIVA UNA SOLA: per ora si lavora esclusivamente il caso più semplice e
 * meno rischioso, le 5 stelle senza commento — un ringraziamento non può
 * essere sbagliato nel merito. Le altre restano scritte e pronte ma spente:
 * descrivono comunque la prassi rilevata dai ticket reali, e si accendono una
 * alla volta da Impostazioni quando saremo pronti a provarle.
 */
export function regoleDiDefault(): Regola[] {
  return [
    {
      id: "5-stelle-senza-testo",
      nome: "5 stelle senza testo",
      attiva: true,
      condizione: { stelle: [5], testo: "senza" },
      azioni: [
        // Primo passaggio, ed è quello che apre il ticket: Stefania risponde
        // "Grazie." all'email, il messaggio arriva a customer.care e Freshdesk
        // genera il ticket. Verificato sulla conversazione di Nadia Mari:
        //   20/07 10:35:06  Stefania → customer.care  "Grazie."
        //   20/07 10:35:12  ← "Ticket Creato"
        // Destinatario lasciato vuoto: si segue il Reply-To dell'email, che
        // Zapier imposta già a customer.care@galdierirent.it.
        azione("a1", "email.rispondi", {
          a: "",
          testo: "Grazie.",
          testoInglese: "Thank you.",
        }),
        azione("a2", "freshdesk.trovaTicket"),
        azione("a3", "freshdesk.classifica", {
          tipo: TIPO_TICKET_GMB,
          specifica1: "positiva",
          specifica2: "5 stelle",
        }),
        azione("a4", "freshdesk.tag", { tag: "{sede}" }),
        azione("a5", "freshdesk.assegna", { agenteId: AGENTE_MARKETING }),
        // Recensione senza commento: si risponde solo "Grazie.", niente di più.
        // Non c'è nulla nel merito a cui replicare.
        azione("a6", "google.rispondi", { testo: "Grazie.", testoInglese: "Thank you." }),
        azione("a7", "freshdesk.stato", { stato: "4" }),
      ],
    },
    {
      id: "5-stelle-con-testo",
      nome: "5 stelle con testo",
      attiva: false,
      condizione: { stelle: [5], testo: "con" },
      azioni: [
        azione("b1", "freshdesk.trovaTicket"),
        azione("b2", "freshdesk.classifica", {
          tipo: TIPO_TICKET_GMB,
          specifica1: "positiva",
          specifica2: "5 stelle",
        }),
        azione("b3", "freshdesk.tag", { tag: "{sede}, {personale}" }),
        azione("b4", "freshdesk.assegna", { agenteId: AGENTE_MARKETING }),
        azione("b5", "google.rispondi", {
          testo:
            "Grazie {nome} per le sue parole! Siamo felici che il servizio della sede di {sede} sia stato all'altezza. A presto da Galdieri rent.",
        }),
        azione("b6", "freshdesk.stato", { stato: "4" }),
      ],
    },
    {
      id: "4-stelle",
      nome: "4 stelle",
      attiva: false,
      condizione: { stelle: [4], testo: "qualsiasi" },
      azioni: [
        azione("c1", "freshdesk.trovaTicket"),
        azione("c2", "freshdesk.classifica", {
          tipo: TIPO_TICKET_GMB,
          specifica1: "positiva",
          specifica2: "4 stelle",
        }),
        azione("c3", "freshdesk.tag", { tag: "{sede}, {personale}" }),
        azione("c4", "freshdesk.assegna", { agenteId: AGENTE_MARKETING }),
        azione("c5", "google.rispondi", {
          testo:
            "Grazie {nome} per la recensione. Siamo a disposizione per rendere il prossimo noleggio ancora migliore. A presto da Galdieri rent.",
        }),
        azione("c6", "freshdesk.stato", { stato: "4" }),
      ],
    },
    {
      id: "3-stelle",
      nome: "3 stelle — revisione manuale",
      attiva: false,
      condizione: { stelle: [3], testo: "qualsiasi" },
      azioni: [
        azione("d1", "freshdesk.trovaTicket"),
        azione("d2", "freshdesk.classifica", {
          tipo: TIPO_TICKET_GMB,
          specifica1: "negativa",
          specifica2: "3 stelle",
        }),
        azione("d3", "freshdesk.tag", { tag: "{sede}" }),
        azione("d4", "freshdesk.assegna", { agenteId: AGENTE_ESCALATION }),
        azione("d5", "freshdesk.stato", { stato: "2" }),
        azione("d6", "sistema.attendiRisposta", { da: EMAIL_ESCALATION }),
      ],
    },
    {
      id: "1-2-stelle",
      nome: "1 e 2 stelle — escalation",
      attiva: true,
      condizione: { stelle: [1, 2], testo: "qualsiasi" },
      // Ricalca il ciclo osservato sui casi reali, per esempio Amelia
      // Castanheira, Guy Cohen, Maureen Nicolas:
      //   1. Stefania inoltra a Cherubina, in copia a customer.care
      //   2. il CC fa nascere il ticket entro un minuto
      //   3. dopo 4-6 giorni Cherubina rimanda il testo della risposta
      //   4. Stefania lo pubblica e il ticket si chiude
      // Qui automatizziamo il passo 1 e prepariamo il terreno; dal passo 3 in
      // poi serve una persona, e il flusso resta in attesa.
      azioni: [
        azione("e1", "email.inoltra", {
          a: EMAIL_ESCALATION,
          // Senza questa copia il messaggio arriva a Cherubina ma nessun
          // ticket viene aperto: verificato su 40 inoltri reali su 41.
          cc: EMAIL_TICKETING,
          testo: TESTO_ESCALATION,
        }),
        azione("e2", "freshdesk.trovaTicket"),
        azione("e3", "freshdesk.tag", { tag: "{sede}" }),
        azione("e4", "freshdesk.assegna", { agenteId: AGENTE_ESCALATION }),
        azione("e5", "sistema.attendiRisposta", { da: EMAIL_ESCALATION }),
      ],
    },
  ];
}

export async function caricaRegole(): Promise<Regola[]> {
  try {
    const regole = await leggiRegole();
    if (regole.length > 0) return regole;
  } catch (e) {
    console.error("[regole] lettura non riuscita:", e);
  }
  // Database vuoto o irraggiungibile: le regole di default restano la rete di
  // sicurezza. Sono anche il seme del primo avvio e il bersaglio del
  // ripristino, quindi vivono nel codice e non solo nel database.
  return regoleDiDefault();
}

export async function salvaRegole(regole: Regola[], origine: Origine = "interfaccia"): Promise<void> {
  await scriviRegole(regole, origine);
}

/** Prima regola attiva che copre la recensione, oppure null. */
export function regolaPer(
  regole: Regola[],
  stelle: number | null,
  conTesto: boolean,
): Regola | null {
  for (const r of regole) {
    if (!r.attiva) continue;
    if (stelle === null || !r.condizione.stelle.includes(stelle)) continue;
    if (r.condizione.testo === "con" && !conTesto) continue;
    if (r.condizione.testo === "senza" && conTesto) continue;
    return r;
  }
  return null;
}
