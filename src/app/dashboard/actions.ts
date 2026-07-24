"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eseguiRegola } from "@/server/automation/engine";
import { testoPerRecensione } from "@/server/automation/connectors";
import { caricaRegole, regolaPer, EMAIL_TICKETING } from "@/server/automation/rules";
import { eliminaEsecuzione, registraEsecuzione } from "@/server/automation/runs";
import type { Esecuzione, Regola } from "@/server/automation/types";
import { caricaRecensioni, haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import { approvaPerPubblicazione } from "@/server/db/pubblicazioni";
import { normalizzaSede } from "@/server/db/seed";
import { loadSettings } from "@/server/settings";

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

/**
 * Approva la risposta suggerita ed esegue la regola che copre la recensione.
 *
 * Il testo che arriva dal form è quello che l'operatore ha davanti: se non lo
 * ha toccato è identico al suggerimento, se lo ha riscritto vince la sua
 * versione. In entrambi i casi parte solo da qui, mai da solo.
 */
export async function approvaAction(formData: FormData): Promise<void> {
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
  await accodaSePubblicabile(regola, recensione, testo, esecuzione);

  revalidatePath("/");
  revalidatePath("/da-pubblicare");
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
  });
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

/** Rimette una recensione fra quelle da gestire cancellando la prova. */
export async function rimettiInCodaAction(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (id) await eliminaEsecuzione(id);
  revalidatePath("/");
  indietro(formData);
}
