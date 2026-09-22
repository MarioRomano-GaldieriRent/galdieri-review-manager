"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eseguiRegola, type TestoRiscritto } from "@/server/automation/engine";
import { testoPerRecensione } from "@/server/automation/connectors";
import {
  caricaRegole,
  conBeta,
  nodiRisposta,
  regolaPer,
  EMAIL_TICKETING,
} from "@/server/automation/rules";
import { eliminaEsecuzione, registraEsecuzione, scostamentiDa } from "@/server/automation/runs";
import type { Regola } from "@/server/automation/types";
import { haTesto, type Recensione } from "@/server/reviews/load";
import {
  accodaSePubblicabile,
  inoltraERegistra,
  metodoRobot,
  rispondiERegistra,
} from "@/server/automation/rispondi";
import { archiviaRecensione, leggiRecensione, ripristinaRecensione } from "@/server/db/recensioni";
import { registraVersione } from "@/server/db/storicoTesti";
import { nomeGoogleDiSede } from "@/server/db/sedi";
import { richiediOperatore } from "@/server/auth/sessione";
import { impostaMostraTutte } from "@/server/auth/utenti";
import { cercaTicketPerRecensione, STATO } from "@/server/integrations/freshdesk";
import { avviaRobotConEsito, type EsitoRobot } from "@/server/robot/lancia";
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
  if (!chiave) indietro(fd);
  // Dall'ARCHIVIO Mongo (non più riscaricando le email): così si trova anche una
  // recensione dell'arretrato, non solo quelle nella finestra della posta.
  const r = await leggiRecensione(chiave);
  if (!r) indietro(fd, { errore: "recensione-non-trovata" });
  return r;
}

/** Come sopra, ma per le azioni che RITORNANO un valore (non redirigono). */
async function trovaRecensionePerChiave(chiave: string): Promise<Recensione | null> {
  if (!chiave) return null;
  return (await leggiRecensione(chiave)) ?? null;
}


/**
 * Conserva la proposta che stava nel riquadro. Non distingue fra il testo di
 * una regola e quello dell'AI: dal form arriva già scelto, ed è comunque la
 * proposta che quella persona ha visto — che è il fatto da registrare.
 */
async function registraProposta(chiave: string, proposta: string, regolaId: string): Promise<void> {
  if (!proposta) return;
  await registraVersione({
    recensioneChiave: chiave,
    tipo: "proposta-regola",
    testo: proposta,
    origine: "regola",
    rif: { regolaId },
  });
}

/**
 * La riscrittura da passare al motore: il testo del box, applicato a TUTTI i
 * nodi che rispondono al cliente (email e Google). null se l'operatore non ha
 * toccato nulla — in quel caso vale la regola, con la sua scelta di lingua.
 *
 * I nodi si ricavano dalla REGOLA, non dal campo nascosto `azioneId` del form.
 * Quel campo portava l'id di UN solo nodo, quello mostrato nella card, che è
 * sempre il nodo Google; e siccome playAction toglie il nodo Google dalla
 * regola prima di eseguirla (su Google ha già pubblicato il robot), la
 * riscrittura non trovava più il suo bersaglio e non veniva applicata a niente:
 * su Google usciva il testo dell'operatore, per email quello della regola. È il
 * caso di «rhita prince» — «Thank you.» su Google, «Grazie.» nella mail che
 * apre il ticket.
 */
function riscritturaPer(
  regola: Regola,
  testo: string,
  originale: string,
): TestoRiscritto | null {
  if (!testo || testo === originale) return null;
  const azioni = nodiRisposta(regola).map((a) => a.id);
  return azioni.length > 0 ? { azioni, testo, originale } : null;
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

  // conBeta: le regole in anteprima di questa persona contano come attive solo
  // per lei (così card e azione concordano su cosa copre la recensione).
  const regole = conBeta(await caricaRegole(), op.regoleBeta ?? []);
  const regola = regolaPer(regole, recensione.stelle, haTesto(recensione));
  if (!regola) indietro(formData, { errore: "nessuna-regola" });

  const testo = String(formData.get("testo") ?? "").trim();
  const originale = String(formData.get("testoOriginale") ?? "").trim();
  // Si sovrascrive solo quando il testo è stato davvero cambiato: altrimenti
  // la regola resta quella scritta in Impostazioni, senza copie inutili.
  const riscritto = riscritturaPer(regola, testo, originale);

  // Quello che l'operatore aveva DAVANTI, prima di toccarlo: è il «prima» della
  // coppia che servirà a tarare l'AI. Si conserva sempre, anche quando il testo
  // non è stato cambiato — «la proposta andava bene così» è un'informazione.
  await registraProposta(recensione.chiave, originale, regola.id);

  const esecuzione = await eseguiRegola(regola, recensione, riscritto);
  await registraEsecuzione(esecuzione, scostamentiDa(riscritto));

  // Aggancio alla coda di pubblicazione manuale: solo le recensioni con una
  // risposta pubblica su Google (le positive) ci finiscono. Le negative vanno
  // a Cherubina e restano nella colonna d'attesa, non in coda.
  await accodaSePubblicabile(regola, recensione, testo, esecuzione, op._id);

  revalidatePath("/");
  indietro(formData, { run: esecuzione.id });
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

/**
 * Fase 1 delle recensioni NEGATIVE (1-2★): esegue la regola FINO ALL'ATTESA —
 * inoltro a Cherubina (CC customer.care, che apre il ticket), aggancio, classifica,
 * tag e assegnazione — poi si ferma. Niente Google, niente coda di pubblicazione:
 * la risposta arriverà da Cherubina e si pubblicherà in un secondo momento.
 */
export async function avviaEscalationAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const recensione = await trovaRecensione(formData);

  const regole = conBeta(await caricaRegole(), op.regoleBeta ?? []);
  const regola = regolaPer(regole, recensione.stelle, haTesto(recensione));
  if (!regola) indietro(formData, { errore: "nessuna-regola" });

  // La Fase 1 — nodi fino all'attesa, poi la voce «In attesa» — è la stessa che
  // fa il pilota: una funzione sola, così tasto e automazione non divergono.
  const { esecuzione } = await inoltraERegistra({ recensione, regola, operatoreId: op._id });

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

  // Il box va compilato: niente più ripiego automatico su "Grazie.".
  const risposta = (testo || "").trim();
  if (!risposta) {
    return {
      ok: false,
      stato: "vuoto",
      messaggio: "Scrivi prima la risposta nel box, poi clicca la G.",
    };
  }

  const r = await trovaRecensionePerChiave(chiave);
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

  // Se la sede è mappata, il robot va dritto lì; altrimenti ripiega sui gruppi.
  const nomeGoogle = await nomeGoogleDiSede(r.sede);
  return avviaRobotConEsito({
    azione: "cerca",
    nome: r.nome,
    testo: risposta,
    nomeGoogle,
    // Il testo vero della recensione: senza questo la coda può riconoscerla
    // solo dal nome, che da solo non basta più.
    testoRecensione: r.originale,
    metodo: metodoRobot(r),
  });
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

  const regole = conBeta(await caricaRegole(), op.regoleBeta ?? []);
  const regola = regolaPer(regole, recensione.stelle, haTesto(recensione));
  if (!regola) indietro(formData, { errore: "nessuna-regola" });

  const testo = String(formData.get("testo") ?? "").trim();
  const originale = String(formData.get("testoOriginale") ?? "").trim();
  const riscritto = riscritturaPer(regola, testo, originale);
  await registraProposta(recensione.chiave, originale, regola.id);

  // Tutto il percorso — robot su Google, resto della regola, pubblicazione e
  // chiusura del ticket — sta in rispondiERegistra, lo stesso che usa
  // l'automazione: il tasto e il pilota non possono divergere.
  const esito = await rispondiERegistra({
    recensione,
    regola,
    testo,
    riscritto,
    operatoreId: op._id,
    operatoreNome: op.nome,
    metodo: "manuale",
  });

  if (esito.tipo === "vuoto") {
    indietro(formData, esitoQuery(recensione.chiave, {
      ok: false,
      stato: "vuoto",
      messaggio: "Scrivi prima la risposta nel box: su una recensione negativa non si pubblica un «Grazie.» automatico.",
    }));
  }
  if (esito.tipo === "google-ko") {
    // Google non fatto → email e Freshdesk NON toccati. Resta in lista, si riprova.
    indietro(formData, esitoQuery(recensione.chiave, esito.robot));
  }

  revalidatePath("/");
  indietro(formData, { run: esito.esecuzione.id, ...esitoQuery(recensione.chiave, esito.robot) });
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
    // forza: è un refresh esplicito on-click, deve mostrare lo stato FRESCO
    // del ticket (non quello in cache fino a 60s).
    const { ticket, motivo } = await cercaTicketPerRecensione(r.oggetto, r.ricevutaIl, r.nome, {
      forza: true,
    });
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

/**
 * L'occhio della home: salva sul profilo di chi clicca se vuole vedere TUTTE le
 * recensioni o solo quelle coperte da una regola attiva. Non è un filtro di
 * sessione né un parametro nell'indirizzo: resta com'è stato lasciato, anche
 * dopo il logout, e vale solo per quella persona.
 */
export async function mostraTutteAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  await impostaMostraTutte(op._id, str(formData, "valore") === "1");
  revalidatePath("/");
  redirect("/");
}
