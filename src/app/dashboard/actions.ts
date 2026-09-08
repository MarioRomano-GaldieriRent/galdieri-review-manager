"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eseguiRegola } from "@/server/automation/engine";
import { testoPerRecensione, testoPerRecensioneConLingua } from "@/server/automation/connectors";
import {
  caricaRegole,
  conBeta,
  nodiRisposta,
  regolaPer,
  EMAIL_TICKETING,
} from "@/server/automation/rules";
import { eliminaEsecuzione, registraEsecuzione } from "@/server/automation/runs";
import type { Esecuzione, Regola } from "@/server/automation/types";
import { haTesto, testoRecensione, type Recensione } from "@/server/reviews/load";
import { linguaRispostaIA } from "@/server/reviews/linguaNomeAI";
import {
  approvaPerPubblicazione,
  leggiPubblicazione,
  segnaPubblicata,
} from "@/server/db/pubblicazioni";
import { chiudiFreshdeskPer, programmaChiusuraFreshdesk } from "@/server/pubblicazione";
import { archiviaRecensione, leggiRecensione, ripristinaRecensione } from "@/server/db/recensioni";
import {
  leggiEscalation,
  registraInoltro,
  segnaChiusa,
  ticketDiEscalation,
} from "@/server/db/escalation";
import { normalizzaSede } from "@/server/db/seed";
import { nomeGoogleDiSede } from "@/server/db/sedi";
import { modoOperativo } from "@/server/settings";
import { richiediOperatore } from "@/server/auth/sessione";
import { impostaMostraTutte } from "@/server/auth/utenti";
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
 * Quale metodo di ricerca deve provare per PRIMO il robot su Google. L'altro
 * resta sempre come ripiego: non si butta via nessuna delle due strade.
 *
 * Recensione CON testo — quelle che arrivano dal customer care: la CODA
 * «Rispondere a recensioni». Mostra SOLO le recensioni ancora senza risposta,
 * una alla volta, e la riconosce dal TESTO: è l'unica prova che regge quando
 * l'autore si chiama «D» o quando due clienti sono omonimi. È il metodo che
 * nelle prove arriva molto più lontano della ricerca nella lista.
 *
 * Recensione SENZA testo — la 5★ secca: la LISTA, il metodo classico. Nella
 * coda non ci sarebbe niente da confrontare e si finirebbe per scrivere sotto
 * la recensione del primo omonimo che passa.
 *
 * La foto non entra nella scelta perché il dato non esiste: il campo
 * `photoChecked` è previsto nello schema ma nessuno lo valorizza (nessun
 * rilevamento foto è mai stato scritto). Finché non arriverà, «5★ senza testo e
 * senza foto» e «5★ senza testo» sono lo stesso insieme di recensioni.
 */
function metodoRobot(r: Recensione): "coda" | "lista" {
  return haTesto(r) ? "coda" : "lista";
}

/**
 * Quanto aspettare il robot prima di ucciderlo. Vale per ENTRAMBI i metodi:
 * anche partendo dalla lista si può finire nella coda come ripiego, e i salti
 * di «Ignora» possono essere decine — la scadenza interna del robot è 200
 * secondi. Con i 3 minuti di default veniva ammazzato proprio mentre stava
 * arrivando in fondo, che è il motivo per cui il «rispondi» sembrava arrendersi
 * prima della prova. È un tetto, non un'attesa fissa: se conclude prima, torna
 * subito.
 */
const ATTESA_ROBOT_MS = 5 * 60 * 1000;

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
): { azioni: string[]; testo: string } | null {
  if (!testo || testo === originale) return null;
  const azioni = nodiRisposta(regola).map((a) => a.id);
  return azioni.length > 0 ? { azioni, testo } : null;
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

  // Il fallback (box svuotato dall'operatore) chiede la lingua all'IA come il
  // resto del flusso — non alla whitelist sincrona, che qui non serve: questa
  // funzione è già async.
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
  // citando «ticket N», e quel numero è già salvato lì. Per «D» c'era, e la
  // chiusura partiva lo stesso con «nessun ticket collegato».
  const ticketId = idTicket ? Number(idTicket[1]) : await ticketDiEscalation(recensione.chiave);

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

  // Solo i nodi FINO all'attesa inclusa (la Fase 1). Senza un nodo di attesa si
  // eseguono tutti (regola senza flusso di ritorno).
  const iAttesa = regola.azioni.findIndex((a) => a.tipo === "sistema.attendiRisposta");
  const fase1 = iAttesa >= 0 ? { ...regola, azioni: regola.azioni.slice(0, iAttesa + 1) } : regola;

  const esecuzione = await eseguiRegola(fase1, recensione);
  await registraEsecuzione(esecuzione);

  // Registra l'escalation: la recensione passa in «In attesa» finché il customer
  // care non rimanda la risposta. Il ticket, se il nodo l'ha agganciato, si legge
  // dal suo messaggio (#id) senza rileggere Freshdesk.
  const nodoTicket = esecuzione.nodi.find((n) => n.tipo === "freshdesk.trovaTicket");
  const mTicket = nodoTicket?.messaggio.match(/#(\d+)/);
  await registraInoltro(recensione, {
    ticketId: mTicket ? Number(mTicket[1]) : null,
    operatoreId: op._id,
  });

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

  const modo = await modoOperativo();

  // Il ripiego automatico vale SOLO per le recensioni positive (≥4★, il caso
  // «5★ senza commento»). Su una negativa senza testo NON si pubblica nulla:
  // la risposta la fornisce Cherubina e va scritta nel box.
  //
  // Normalmente il box arriva già compilato nella lingua giusta (il nodo
  // google.rispondi passa dalla stessa linguaRisposta): questo ripiego serve
  // solo se l'operatore lo svuota. Senza testo da cui riconoscere la lingua,
  // decide il NOME — «Grazie.» per un nome italiano, «Thank you.» altrimenti.
  const positiva = (recensione.stelle ?? 0) >= 4;
  const linguaFallback = positiva
    ? await linguaRispostaIA(recensione.lingua, recensione.originale, recensione.nome)
    : "it";
  const testoPubblicazione =
    testo || (positiva ? (linguaFallback === "altra" ? "Thank you." : "Grazie.") : "");
  if (!testoPubblicazione.trim()) {
    indietro(formData, esitoQuery(recensione.chiave, {
      ok: false,
      stato: "vuoto",
      messaggio: "Scrivi prima la risposta nel box: su una recensione negativa non si pubblica un «Grazie.» automatico.",
    }));
  }

  // GOOGLE PER PRIMO (regola «5 stelle senza foto»): la pubblicazione su Google
  // è il passo che conta ed è il più fragile. Se il robot NON pubblica, non ha
  // senso fare il resto (email, ticket): il robot è il "cancello" iniziale.
  // Il metodo lo decide il TIPO di recensione: coda per quelle con testo (il
  // grosso di quelle che arrivano dal customer care), lista per le 5★ secche.
  const metodo = metodoRobot(recensione);
  const e = await lanciaRobot(
    {
      azione: modo === "reale" ? "pubblica" : "test",
      nome: recensione.nome,
      testo: testoPubblicazione,
      nomeGoogle: await nomeGoogleDiSede(recensione.sede),
      // MANCAVA: senza il testo della recensione la coda poteva riconoscerla
      // solo dal nome — e da quando il solo nome non basta più, nel flusso vero
      // non concludeva quasi mai, mentre il tasto di prova (che il testo lo
      // passava) arrivava in fondo. È la differenza che si vedeva sulla card.
      testoRecensione: recensione.originale,
      metodo,
    },
    { attesaMs: ATTESA_ROBOT_MS },
  );

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
  // Se la recensione è già passata dall'escalation (inoltro fatto, risposta
  // del customer care arrivata), questa è la FASE 2: si eseguono solo i nodi
  // DOPO «attendi la risposta». Rifare tutta la regola voleva dire inoltrare
  // di nuovo la recensione a Cherubina e ricercare il ticket da capo — è
  // quello che è successo su «D» alla pubblicazione.
  const daFase2 = (await leggiEscalation(recensione.chiave)) != null;
  const iAttesa = regola.azioni.findIndex((a) => a.tipo === "sistema.attendiRisposta");
  const azioniDaFare = daFase2 && iAttesa >= 0 ? regola.azioni.slice(iAttesa + 1) : regola.azioni;
  const regolaDopoGoogle = {
    ...regola,
    azioni: azioniDaFare.filter(
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
      if (voce) {
        // POSITIVE (5★/4★): il ticket è stato aperto pochi secondi fa da questa
        // stessa pubblicazione. Non lo risolviamo subito — Freshdesk non farebbe
        // in tempo a mandare le sue mail: PROGRAMMIAMO la risoluzione a +15 min,
        // che la sweep alla home eseguirà a un ricarico successivo.
        //
        // Vale ANCHE quando il ticket non è stato agganciato (tipico: un 429 sul
        // nodo «Trova il ticket», o il ticket non ancora nato). Prima in quel
        // caso si tentava di chiudere all'istante, il che voleva dire dichiarare
        // fallimento un secondo dopo aver mandato la mail che apre il ticket:
        // adesso lo si rimanda, e la chiusura programmata lo ricercherà con il
        // budget di Freshdesk di nuovo libero.
        if (positiva) {
          await programmaChiusuraFreshdesk(recensione.chiave);
        } else {
          // NEGATIVE «pronte»: il ticket è aperto da giorni, si risolve adesso.
          await chiudiFreshdeskPer(voce, op.nome);
        }
      }
    }
    // Se era una negativa «pronta» (risposta del customer care pubblicata ora),
    // esce dal ciclo escalation. No-op se non c'era una voce in attesa.
    await segnaChiusa(recensione.chiave);
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
