"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eseguiRegola } from "@/server/automation/engine";
import { testoPerRecensione } from "@/server/automation/connectors";
import { caricaRegole, regolaPer, EMAIL_TICKETING } from "@/server/automation/rules";
import { eliminaEsecuzione, registraEsecuzione } from "@/server/automation/runs";
import type { Esecuzione, Regola } from "@/server/automation/types";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import {
  approvaPerPubblicazione,
  leggiPubblicazione,
  segnaPubblicata,
} from "@/server/db/pubblicazioni";
import { chiudiFreshdeskPer } from "@/server/pubblicazione";
import { archiviaRecensione, ripristinaRecensione } from "@/server/db/recensioni";
import { normalizzaSede } from "@/server/db/seed";
import { loadSettings, modoOperativo } from "@/server/settings";
import { richiediOperatore } from "@/server/auth/sessione";
import { cercaTicketPerRecensione, STATO } from "@/server/integrations/freshdesk";
import { avviaRobotConEsito, lanciaRobot, type EsitoRobot } from "@/server/robot/lancia";
import { chromeInEsecuzione } from "@/server/robot/google";

// Le tre azioni della dashboard: approvare la risposta, inoltrare al customer
// care, rimettere in coda una recensione già lavorata.
//
// Nessuna di queste decide se scrivere davvero: quella scelta sta in un unico
// punto, scritturaConsentita() in settings.ts, e la rispettano tutti i nodi.
// Qui in simulazione si esegue lo stesso identico flusso, semplicemente le
// chiamate verso Freshdesk, Google e la posta non partono.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Torna alla dashboard conservando il filtro da cui si era partiti. */
function indietro(fd: FormData, extra: Record<string, string> = {}): never {
  const p = new URLSearchParams(extra);
  const stelle = str(fd, "stelle");
  if (stelle) p.set("stelle", stelle);
  const s = p.toString();
  redirect(s ? `/?${s}` : "/");
}

async function trovaRecensione(fd: FormData): Promise<Recensione> {
  const chiave = str(fd, "chiave");
  const settings = await loadSettings();
  const label = settings.labels.find((l) => l.id === str(fd, "label")) ?? settings.labels[0];
  if (!chiave || !label) indietro(fd);

  const { recensioni } = await caricaRecensioni(label);
  const r = recensioni.find((x) => x.chiave === chiave);
  if (!r) indietro(fd, { errore: "recensione-non-trovata" });
  return r;
}

/** Come sopra, ma per le azioni che RITORNANO un valore (non redirigono). */
async function trovaRecensionePerChiave(
  chiave: string,
  labelId: string,
): Promise<Recensione | null> {
  const settings = await loadSettings();
  const label = settings.labels.find((l) => l.id === labelId) ?? settings.labels[0];
  if (!chiave || !label) return null;
  const { recensioni } = await caricaRecensioni(label);
  return recensioni.find((x) => x.chiave === chiave) ?? null;
}

/**
 * Approva la risposta suggerita ed esegue la regola che copre la recensione.
 *
 * Il testo che arriva dal form è quello che l'operatore ha davanti: se non lo
 * ha toccato è identico al suggerimento, se lo ha riscritto vince la sua
 * versione. In entrambi i casi parte solo da qui, mai da solo.
 */
export async function approvaAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const recensione = await trovaRecensione(formData);

  const regole = await caricaRegole();
  const regola = regolaPer(regole, recensione.stelle, haTesto(recensione));
  if (!regola) indietro(formData, { errore: "nessuna-regola" });

  const azioneId = str(formData, "azioneId");
  const testo = String(formData.get("testo") ?? "").trim();
  const originale = String(formData.get("testoOriginale") ?? "").trim();
  // Si sovrascrive solo quando il testo è stato davvero cambiato: altrimenti
  // la regola resta quella scritta in Impostazioni, senza copie inutili.
  const riscritto = azioneId && testo && testo !== originale ? { azioneId, testo } : null;

  const esecuzione = await eseguiRegola(regola, recensione, riscritto);
  await registraEsecuzione(esecuzione);

  // Aggancio alla coda di pubblicazione manuale: solo le recensioni con una
  // risposta pubblica su Google (le positive) ci finiscono. Le negative vanno
  // a Cherubina e restano nella colonna d'attesa, non in coda.
  await accodaSePubblicabile(regola, recensione, testo, esecuzione, op._id);

  revalidatePath("/");
  indietro(formData, { run: esecuzione.id });
}

/**
 * Se la regola prevede una risposta su Google, mette la recensione nella coda
 * "da pubblicare" con il testo approvato. L'id del ticket si legge dal nodo
 * «Trova il ticket» dell'esecuzione appena fatta, senza rileggere Freshdesk.
 */
async function accodaSePubblicabile(
  regola: Regola,
  recensione: Recensione,
  testoForm: string,
  esecuzione: Esecuzione,
  operatoreId: number,
): Promise<void> {
  const nodoGoogle = regola.azioni.find((a) => a.tipo === "google.rispondi");
  if (!nodoGoogle) return;

  const testoRisposta = testoForm || testoPerRecensione(nodoGoogle, recensione).testo;
  if (!testoRisposta.trim()) return; // niente da pubblicare

  const nodoTicket = esecuzione.nodi.find((n) => n.tipo === "freshdesk.trovaTicket");
  const idTicket = nodoTicket?.messaggio.match(/#(\d+)/);
  const ticketId = idTicket ? Number(idTicket[1]) : null;

  await approvaPerPubblicazione({
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
  }, operatoreId);
}

/**
 * Inoltro al customer care, la via d'uscita quando la risposta automatica non
 * va bene o non esiste nessuna regola per quella recensione.
 *
 * Ricalca l'inoltro reale: destinatario e testo vengono dalle Impostazioni, e
 * la copia a customer.care non è un dettaglio ma è ciò che apre il ticket su
 * Freshdesk — verificato su 40 inoltri reali su 41.
 */
export async function inoltraAction(formData: FormData): Promise<void> {
  await richiediOperatore();
  const recensione = await trovaRecensione(formData);

  const inoltro: Regola = {
    id: "inoltro-manuale",
    nome: "Inoltro al customer care",
    attiva: true,
    condizione: { stelle: [1, 2, 3, 4, 5], testo: "qualsiasi" },
    azioni: [
      // Destinatario e testo vuoti: li prende dalle Impostazioni.
      { id: "i1", tipo: "email.inoltra", parametri: { a: "", cc: EMAIL_TICKETING, testo: "" } },
      { id: "i2", tipo: "freshdesk.trovaTicket", parametri: {} },
      { id: "i3", tipo: "sistema.attendiRisposta", parametri: { da: "" } },
    ],
  };

  const esecuzione = await eseguiRegola(inoltro, recensione);
  await registraEsecuzione(esecuzione);

  revalidatePath("/");
  indietro(formData, { run: esecuzione.id });
}

// --- Bottoni della card: Play, Test Google, Aggiorna ticket ----------------
// Tutti MANUALI: partono solo al click. Il robot Google è "usa e getta" (apre
// il browser, fa la cosa, si chiude) e serve Chrome chiuso in quel momento.

/** Riporta l'esito di un'azione sulla card, come parametri d'indirizzo. */
function esitoQuery(chiave: string, e: EsitoRobot): Record<string, string> {
  return { esitoChiave: chiave, esitoOk: e.ok ? "1" : "0", esitoMsg: e.messaggio.slice(0, 240) };
}

/**
 * Tasto "G" (chiamato dal client, RITORNA l'esito): apre il robot su Google e
 * aspetta SOLO il primo esito — trovata / non trovata — che il runner stampa
 * appena finita la ricerca; poi lascia la finestra aperta per conto suo. Così il
 * front mostra "sto cercando…" e subito dopo l'esito, senza ricaricare la pagina.
 */
export async function cercaSuGoogleAction(
  chiave: string,
  labelId: string,
  testo: string,
): Promise<EsitoRobot> {
  await richiediOperatore();

  const r = await trovaRecensionePerChiave(chiave, labelId);
  if (!r) {
    return {
      ok: false,
      stato: "recensione-non-trovata",
      messaggio: "Recensione non più in elenco: aggiorna la pagina e riprova.",
    };
  }

  if (chromeInEsecuzione()) {
    return {
      ok: false,
      stato: "chrome-aperto",
      messaggio: "Chiudi tutte le finestre di Chrome, poi riclicca la G: il robot deve aprire il suo Chrome.",
    };
  }

  return avviaRobotConEsito({ azione: "cerca", nome: r.nome, testo: (testo || "").trim() || "Grazie." });
}

/**
 * ▶ Play: esegue tutto il flusso della regola (email + Freshdesk, reali se sei
 * in Modalità Reale) e poi apre il robot per Google. In Reale PUBBLICA davvero;
 * in simulazione il robot fa solo il test (niente di reale), così resta coerente
 * col principio "un solo punto decide se scrivere davvero".
 */
export async function playAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const recensione = await trovaRecensione(formData);

  const regole = await caricaRegole();
  const regola = regolaPer(regole, recensione.stelle, haTesto(recensione));
  if (!regola) indietro(formData, { errore: "nessuna-regola" });

  const azioneId = str(formData, "azioneId");
  const testo = String(formData.get("testo") ?? "").trim();
  const originale = String(formData.get("testoOriginale") ?? "").trim();
  const riscritto = azioneId && testo && testo !== originale ? { azioneId, testo } : null;

  const modo = await modoOperativo();

  // GOOGLE PER PRIMO (regola «5 stelle senza foto»): la pubblicazione su Google
  // è il passo che conta ed è il più fragile. Se il robot NON pubblica, non ha
  // senso fare il resto (email, ticket): il robot è il "cancello" iniziale.
  const e = await lanciaRobot({
    azione: modo === "reale" ? "pubblica" : "test",
    nome: recensione.nome,
    testo: testo || "Grazie.",
  });

  // Via libera: in Reale serve la pubblicazione vera; in simulazione basta che
  // il robot abbia trovato e scritto (test), così si prova il flusso a vuoto.
  const googleOk = modo === "reale" ? e.stato === "pubblicata" : e.ok && e.stato === "scritta";
  if (!googleOk) {
    // Google non fatto → NON tocchiamo email/Freshdesk. Resta in lista, si riprova.
    indietro(formData, esitoQuery(recensione.chiave, e));
  }

  // Google fatto → ora il resto della regola, SENZA i due nodi Google/chiusura:
  //   • google.rispondi (a6): già fatto dal robot (l'API è bloccata, quota 0);
  //   • freshdesk.stato (a7): il ticket lo mette Risolto chiudiFreshdeskPer, che
  //     aggiunge anche tag sede e nota con la risposta pubblicata.
  const regolaDopoGoogle = {
    ...regola,
    azioni: regola.azioni.filter(
      (a) => a.tipo !== "google.rispondi" && a.tipo !== "freshdesk.stato",
    ),
  };
  const esecuzione = await eseguiRegola(regolaDopoGoogle, recensione, riscritto);
  await registraEsecuzione(esecuzione);

  // In Reale: registra la pubblicazione, portala in «da ricontrollare» (così
  // sparisce dalla lista) e chiudi il ticket. In simulazione niente persiste:
  // è una prova a vuoto e la recensione resta in lista.
  if (modo === "reale") {
    await accodaSePubblicabile(regola, recensione, testo, esecuzione, op._id);
    const passata = await segnaPubblicata(recensione.chiave, op._id, false);
    if (passata) {
      const voce = await leggiPubblicazione(recensione.chiave);
      if (voce) await chiudiFreshdeskPer(voce, op.nome);
    }
  }

  revalidatePath("/");
  indietro(formData, { run: esecuzione.id, ...esitoQuery(recensione.chiave, e) });
}

/**
 * 🔄 Aggiorna: interroga Freshdesk (sola lettura) e dice a che punto è il ticket
 * nato da questa recensione — aperto, in attesa, risolto o chiuso.
 */
export async function aggiornaTicketAction(formData: FormData): Promise<void> {
  await richiediOperatore();
  const r = await trovaRecensione(formData);
  let ok = false;
  let messaggio: string;
  try {
    const { ticket, motivo } = await cercaTicketPerRecensione(r.oggetto, r.ricevutaIl, r.nome);
    if (!ticket) {
      messaggio = `Nessun ticket agganciato: ${motivo}`;
    } else {
      ok = true;
      const stato = STATO[ticket.status] ?? `stato ${ticket.status}`;
      const assegnato = ticket.responderId ? "" : " · non ancora assegnato";
      messaggio = `Ticket #${ticket.id}: ${stato}${assegnato}`;
    }
  } catch (e) {
    messaggio = `Freshdesk: ${e instanceof Error ? e.message : "errore"}`;
  }
  indietro(formData, esitoQuery(r.chiave, { ok, stato: "freshdesk", messaggio }));
}

/**
 * 🗄 Archivia: mette da parte una recensione (es. impossibile da gestire). Esce
 * dall'elenco "Da approvare" e finisce nella tab «Archiviati», con il motivo.
 */
export async function archiviaAction(formData: FormData): Promise<void> {
  await richiediOperatore();
  const chiave = str(formData, "chiave");
  const motivo = String(formData.get("motivo") ?? "").trim().slice(0, 200);
  if (chiave) await archiviaRecensione(chiave, motivo);
  revalidatePath("/");
  indietro(formData);
}

/** Ripristina: riporta una recensione archiviata fra quelle da gestire. */
export async function ripristinaAction(formData: FormData): Promise<void> {
  await richiediOperatore();
  const chiave = str(formData, "chiave");
  if (chiave) await ripristinaRecensione(chiave);
  revalidatePath("/");
  redirect("/?step=archiviati");
}

/** Rimette una recensione fra quelle da gestire cancellando la prova. */
export async function rimettiInCodaAction(formData: FormData): Promise<void> {
  await richiediOperatore();
  const id = str(formData, "id");
  if (id) await eliminaEsecuzione(id);
  revalidatePath("/");
  indietro(formData);
}
