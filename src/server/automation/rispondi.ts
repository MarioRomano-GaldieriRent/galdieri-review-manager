import { eseguiRegola, type TestoRiscritto } from "./engine";
import { testoPerRecensioneConLingua } from "./connectors";
import { registraEsecuzione, scostamentiDa } from "./runs";
import type { Esecuzione, Regola } from "./types";
import { haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import { linguaRispostaIA } from "@/server/reviews/linguaNomeAI";
import {
  approvaPerPubblicazione,
  leggiPubblicazione,
  segnaPubblicata,
  type MetodoPubblicazione,
} from "@/server/db/pubblicazioni";
import { chiudiFreshdeskPer, programmaChiusuraFreshdesk } from "@/server/pubblicazione";
import { eliminaBozza } from "@/server/db/bozze";
import { leggiEscalation, segnaChiusa, ticketDiEscalation } from "@/server/db/escalation";
import { normalizzaSede } from "@/server/db/seed";
import { nomeGoogleDiSede } from "@/server/db/sedi";
import { modoOperativo } from "@/server/settings";
import { lanciaRobot, type EsitoRobot } from "@/server/robot/lancia";

// Il percorso completo di una risposta: robot su Google, poi il resto della
// regola (email, Freshdesk), poi pubblicazione registrata e ticket chiuso.
//
// Stava tutto dentro il tasto «Rispondi» (playAction). È uscito da lì perché
// ora lo percorre anche l'automazione, e i due devono fare ESATTAMENTE la
// stessa cosa: una copia per il pilota automatico sarebbe divergita al primo
// ritocco del flusso manuale. Qui niente redirect e niente sessione: chi chiama
// decide cosa fare dell'esito.

/**
 * Quale metodo di ricerca deve provare per PRIMO il robot su Google. L'altro
 * resta sempre come ripiego: non si butta via nessuna delle due strade.
 *
 * Recensione CON testo — quelle che arrivano dal customer care: la CODA
 * «Rispondere a recensioni». Mostra SOLO le recensioni ancora senza risposta,
 * una alla volta, e la riconosce dal TESTO: è l'unica prova che regge quando
 * l'autore si chiama «D» o quando due clienti sono omonimi.
 *
 * Recensione SENZA testo — la 5★ secca: la LISTA, il metodo classico. Nella
 * coda non ci sarebbe niente da confrontare e si finirebbe per scrivere sotto
 * la recensione del primo omonimo che passa.
 *
 * La foto non entra nella scelta perché il dato non esiste: il campo
 * `photoChecked` è previsto nello schema ma nessuno lo valorizza.
 */
export function metodoRobot(r: Recensione): "coda" | "lista" {
  return haTesto(r) ? "coda" : "lista";
}

/**
 * Quanto aspettare il robot prima di ucciderlo. Vale per ENTRAMBI i metodi:
 * anche partendo dalla lista si può finire nella coda come ripiego, e i salti
 * di «Ignora» possono essere decine — la scadenza interna del robot è 200
 * secondi. È un tetto, non un'attesa fissa: se conclude prima, torna subito.
 */
export const ATTESA_ROBOT_MS = 5 * 60 * 1000;

/**
 * Se la regola prevede una risposta su Google, mette la recensione nella coda
 * "da pubblicare" con il testo approvato. L'id del ticket si legge dal nodo
 * «Trova il ticket» dell'esecuzione appena fatta, senza rileggere Freshdesk.
 */
export async function accodaSePubblicabile(
  regola: Regola,
  recensione: Recensione,
  testoForm: string,
  esecuzione: Esecuzione,
  operatoreId: number,
): Promise<void> {
  const nodoGoogle = regola.azioni.find((a) => a.tipo === "google.rispondi");
  if (!nodoGoogle) return;

  // Il fallback (box svuotato dall'operatore) chiede la lingua all'IA come il
  // resto del flusso.
  const linguaSeVuoto = testoForm
    ? null
    : await linguaRispostaIA(recensione.lingua, recensione.originale, recensione.nome);
  const testoRisposta =
    testoForm || testoPerRecensioneConLingua(nodoGoogle, recensione, linguaSeVuoto).testo;
  if (!testoRisposta.trim()) return; // niente da pubblicare

  const nodoTicket = esecuzione.nodi.find((n) => n.tipo === "freshdesk.trovaTicket");
  const idTicket = nodoTicket?.messaggio.match(/#(\d+)/);
  // Il ticket: dal nodo «Trova il ticket» di questa esecuzione; se non l'ha
  // agganciato (nome corto, 429), dall'escalation — il customer care risponde
  // citando «ticket N», e quel numero è già salvato lì.
  const ticketId = idTicket ? Number(idTicket[1]) : await ticketDiEscalation(recensione.chiave);

  await approvaPerPubblicazione(
    {
      chiave: recensione.chiave,
      origine: "google",
      testoRisposta,
      lingua: recensione.lingua,
      nomeCliente: recensione.nome,
      stelle: recensione.stelle,
      sedeChiave: normalizzaSede(recensione.sede),
      sedeNome: recensione.sede,
      testoRecensione: testoRecensione(recensione),
      messaggioId: recensione.messaggioId,
      ticketId,
    },
    operatoreId,
  );
}

export type EsitoRisposta =
  /** Nessun testo da pubblicare (negativa col box vuoto): non è partito niente. */
  | { tipo: "vuoto" }
  /** Il robot non ha pubblicato: email e Freshdesk NON sono stati toccati. */
  | { tipo: "google-ko"; robot: EsitoRobot }
  /** Google fatto (o provato in simulazione) e resto della regola eseguito. */
  | { tipo: "fatto"; robot: EsitoRobot; esecuzione: Esecuzione };

/**
 * Il cuore del tasto «Rispondi», condiviso con l'automazione.
 *
 * GOOGLE PER PRIMO: la pubblicazione su Google è il passo che conta ed è il più
 * fragile. Se il robot NON pubblica, non si fa il resto (email, ticket): nessuno
 * stato a metà, la recensione resta in lista.
 *
 * `metodo` finisce sulla pubblicazione: «manuale» se l'ha premuto una persona,
 * «automatico» se l'ha fatto il pilota — è il dato del badge nello Storico.
 */
export async function rispondiERegistra(opts: {
  recensione: Recensione;
  regola: Regola;
  /** Il testo del box, come l'operatore l'ha lasciato. Vuoto = ripiego automatico. */
  testo: string;
  riscritto: TestoRiscritto | null;
  operatoreId: number;
  operatoreNome: string;
  metodo: MetodoPubblicazione;
}): Promise<EsitoRisposta> {
  const { recensione, regola, testo, riscritto, operatoreId, operatoreNome, metodo } = opts;
  const modo = await modoOperativo();

  // Il ripiego automatico vale SOLO per le recensioni positive (≥4★). Su una
  // negativa senza testo NON si pubblica nulla: la risposta la fornisce
  // Cherubina e va scritta nel box. Senza testo da cui riconoscere la lingua,
  // decide il NOME — «Grazie.» per un nome italiano, «Thank you.» altrimenti.
  const positiva = (recensione.stelle ?? 0) >= 4;
  const linguaFallback = positiva
    ? await linguaRispostaIA(recensione.lingua, recensione.originale, recensione.nome)
    : "it";
  const testoPubblicazione =
    testo || (positiva ? (linguaFallback === "altra" ? "Thank you." : "Grazie.") : "");
  if (!testoPubblicazione.trim()) return { tipo: "vuoto" };

  const robot = await lanciaRobot(
    {
      azione: modo === "reale" ? "pubblica" : "test",
      nome: recensione.nome,
      testo: testoPubblicazione,
      nomeGoogle: await nomeGoogleDiSede(recensione.sede),
      // Senza il testo della recensione la coda potrebbe riconoscerla solo dal
      // nome, che da solo non basta.
      testoRecensione: recensione.originale,
      metodo: metodoRobot(recensione),
    },
    { attesaMs: ATTESA_ROBOT_MS },
  );

  // Via libera: in Reale serve la pubblicazione vera; in simulazione basta che
  // il robot abbia trovato e scritto (test), così si prova il flusso a vuoto.
  const googleOk =
    modo === "reale" ? robot.stato === "pubblicata" : robot.ok && robot.stato === "scritta";
  if (!googleOk) return { tipo: "google-ko", robot };

  // Google fatto → il resto della regola, SENZA i due nodi Google/chiusura:
  //   • google.rispondi: già fatto dal robot;
  //   • freshdesk.stato: il ticket lo mette Risolto chiudiFreshdeskPer, che
  //     aggiunge anche tag sede e nota con la risposta pubblicata.
  // Se la recensione è già passata dall'escalation è la FASE 2: solo i nodi
  // DOPO «attendi la risposta» — rifare tutto vorrebbe dire inoltrare di nuovo.
  const daFase2 = (await leggiEscalation(recensione.chiave)) != null;
  const iAttesa = regola.azioni.findIndex((a) => a.tipo === "sistema.attendiRisposta");
  const azioniDaFare = daFase2 && iAttesa >= 0 ? regola.azioni.slice(iAttesa + 1) : regola.azioni;
  const regolaDopoGoogle = {
    ...regola,
    azioni: azioniDaFare.filter((a) => a.tipo !== "google.rispondi" && a.tipo !== "freshdesk.stato"),
  };
  const esecuzione = await eseguiRegola(regolaDopoGoogle, recensione, riscritto);
  await registraEsecuzione(esecuzione, scostamentiDa(riscritto));

  // In Reale: registra la pubblicazione, portala in «da ricontrollare» e chiudi
  // il ticket. In simulazione niente persiste.
  if (modo === "reale") {
    await accodaSePubblicabile(regola, recensione, testo, esecuzione, operatoreId);
    const passata = await segnaPubblicata(recensione.chiave, operatoreId, false, metodo);
    if (passata) {
      const voce = await leggiPubblicazione(recensione.chiave);
      if (voce) {
        // POSITIVE: il ticket è appena nato da questa stessa pubblicazione; la
        // risoluzione si PROGRAMMA a +15 min, così Freshdesk fa in tempo a
        // mandare le sue mail. Vale anche col ticket non ancora agganciato: la
        // chiusura programmata lo ricercherà.
        if (positiva) {
          await programmaChiusuraFreshdesk(recensione.chiave);
        } else {
          // NEGATIVE «pronte»: il ticket è aperto da giorni, si risolve adesso.
          await chiudiFreshdeskPer(voce, operatoreNome);
        }
      }
    }
    // Una negativa «pronta» esce dal ciclo escalation (no-op se non c'era).
    await segnaChiusa(recensione.chiave);
    // La bozza ha finito il suo compito: il testo è pubblicato.
    await eliminaBozza(recensione.chiave);
  }

  return { tipo: "fatto", robot, esecuzione };
}
