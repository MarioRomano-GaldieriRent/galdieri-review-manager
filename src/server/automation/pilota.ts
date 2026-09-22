import { coll } from "@/server/db/connessione";
import { OPERATORE_SISTEMA, registraAttivita } from "@/server/db/attivita";
import { caricaRegole, regolaPer } from "./rules";
import { testoPerRecensioneConLingua } from "./connectors";
import { inoltraERegistra, rispondiERegistra } from "./rispondi";
import {
  automazioneDi,
  dentroFascia,
  regolaAutomatizzabile,
  regolaEscalationAutomatizzabile,
  type Regola,
} from "./types";
import { haTesto } from "@/server/reviews/load";
import { caricaRecensioni } from "@/server/reviews/load";
import { linguaRispostaIA } from "@/server/reviews/linguaNomeAI";
import {
  chiaviArchiviate,
  confermaTicket,
  leggiRecensione,
  recensioniDaApprovare,
  segnaGestitaFuoriPortale,
  type RecensioneArchiviata,
} from "@/server/db/recensioni";
import { chiaviPubblicate } from "@/server/db/pubblicazioni";
import { chiaviSegnalate, segnala } from "@/server/db/segnalazioni";
import { chiaviConEscalation, chiaviInCiclo, elencoPronte, segnaChiusa } from "@/server/db/escalation";
import {
  MAX_TENTATIVI,
  chiaviAutomazioneEsaurita,
  registraTentativoFallito,
  type FasePilota,
} from "@/server/db/tentativiPilota";
import {
  elencoTicketRecenti,
  recensioniConTicket,
  recensioniConTicketRisolto,
} from "@/server/integrations/freshdesk";
import { ritentaChiusureInSospeso } from "@/server/pubblicazione";
import { aggiornaAttese, motivoPerNonPubblicare } from "@/server/reviews/rispostaCustomerCare";
import { avvisaAdminDiSegnalazione } from "@/server/notifiche/segnalazione";
import { robotOccupato } from "@/server/robot/lancia";
import { chromeInEsecuzione } from "@/server/robot/google";
import { isGraphConfigured } from "@/server/graph/client";
import { loadSettings, modoOperativo } from "@/server/settings";
import { aOraItaliana, giornoSettimana } from "@/server/tempo";

// Il PILOTA AUTOMATICO: fa da solo, nei giorni e negli orari della regola, quello
// che oggi fa una persona premendo «Rispondi».
//
// Un giro:
//   1. controlla che abbia senso partire (modalità reale, fascia, robot libero);
//   2. legge la posta nuova (così le recensioni arrivano in archivio anche se
//      nessuno apre il portale) e ritenta le chiusure Freshdesk rimaste appese;
//   3. sceglie le recensioni: coperte dalla regola, arrivate da almeno
//      `ritardoMinuti`, mai toccate da nessuno — anche quelle arretrate;
//   4. le lavora TUTTE, una dopo l'altra, con rispondiERegistra — lo STESSO
//      codice del tasto — ricontrollando prima di ognuna fascia oraria, robot
//      libero e Chrome chiuso: se nel frattempo scatta la pausa o qualcuno
//      preme «Rispondi», il giro si ferma lì e riprende al successivo.
//
// Le recensioni di una regola automatica NON compaiono in «Da approvare»
// finché il pilota è vivo (vedi pilotaVivo): non sono lavoro per una persona.
//
// Quando qualcosa va storto la recensione passa in SUPERVISIONE: si apre una
// segnalazione (che la toglie dalla coda, quindi non si riprova all'infinito) e
// parte la solita mail all'amministratore. Due eccezioni, che NON sono errori
// della recensione e si limitano a rimandare al giro successivo: il robot già
// occupato (qualcuno sta usando «Rispondi») e un Chrome aperto sul server.
//
// Due famiglie di regole, ciascuna col suo orologio:
//
//  - POSITIVE «senza testo», 4-5★: il testo fisso della regola («Grazie.» /
//    «Thank you.») è la risposta giusta senza che una persona la legga. Si
//    pubblicano in fascia, dopo il ritardo della regola.
//
//  - NEGATIVE 1-2★ a due fasi (decisione di Mario, 22/9/2026):
//      FASE 1 — l'inoltro a Cherubina parte SUBITO, a qualunque ora e senza
//      ritardo: è una mail più qualche chiamata a Freshdesk, niente robot. La
//      recensione non passa più da «Da approvare», va dritta «In attesa».
//      FASE 2 — quando Cherubina risponde, si pubblica il SUO testo: in fascia
//      ma senza ritardo, e solo se il testo sembra davvero una risposta al
//      cliente (motivoPerNonPubblicare).
//    Se un passo fallisce si riprova al giro dopo; al secondo fallimento la
//    recensione passa in Supervisione e l'automazione la lascia alle persone.
//
// Qualunque ALTRA regola messa in automatico (con testo, 3★…) pubblicherebbe un
// testo non riletto: il pilota la rifiuta anche se qualcuno la configura.

/** Un giro che tiene il lucchetto oltre questo tempo è morto (crash, riavvio): si riprende. */
const LUCCHETTO_SCADUTO_MS = 20 * 60 * 1000;
const NOME_LUCCHETTO = "pilota:giro";

export type EsitoGiro = {
  quando: string;
  /** Riassunto per una persona: cosa ha fatto il giro, o perché non è partito. */
  messaggio: string;
  pubblicate: number;
  segnalate: number;
  /** Trovate già risposte su Google: chiuse come gestite, senza pubblicare. */
  giaRisposte: number;
  /** Negative inoltrate a Cherubina in questo giro (Fase 1). */
  inoltrate?: number;
  /** Tentativi falliti che si ripeteranno al giro dopo (il primo di due). */
  daRiprovare?: number;
  /** Solo in prova: le recensioni che il giro avrebbe lavorato. */
  candidate?: {
    nome: string;
    stelle: number | null;
    regola: string;
    ricevutaIl: string;
    /** Che cosa ci farebbe: inoltro (Fase 1), pubblicare la risposta di Cherubina (Fase 2), rispondere. */
    fase: "inoltro" | "risposta-customer-care" | "risposta";
    /** Solo per la Fase 2: perché NON la pubblicherebbe, se il testo non passa il controllo. */
    bloccata?: string;
  }[];
};

function adessoARoma(ora: Date): { giorno: number; oraDecimale: number } {
  const locale = aOraItaliana(ora.toISOString()); // "2026-09-14T10:35:00"
  const oraDecimale = Number(locale.slice(11, 13)) + Number(locale.slice(14, 16)) / 60;
  return { giorno: giornoSettimana(ora.toISOString()), oraDecimale };
}

async function prendiLucchetto(): Promise<boolean> {
  const l = await coll<{ _id: string; preso: Date }>("lucchetti");
  const ora = new Date();
  try {
    await l.insertOne({ _id: NOME_LUCCHETTO, preso: ora });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  // Già preso: da un giro vivo, o da uno morto a metà (riavvio del server).
  const scaduto = await l.deleteOne({
    _id: NOME_LUCCHETTO,
    preso: { $lt: new Date(ora.getTime() - LUCCHETTO_SCADUTO_MS) },
  });
  if (scaduto.deletedCount === 0) return false;
  try {
    await l.insertOne({ _id: NOME_LUCCHETTO, preso: ora });
    return true;
  } catch {
    return false;
  }
}

/**
 * Il giro è vivo: sposta in avanti l'ora del lucchetto. Senza, un giro che
 * lavora molte recensioni supererebbe i 20 minuti e verrebbe creduto morto.
 */
async function rinnovaLucchetto(): Promise<void> {
  await (await coll<{ _id: string; preso: Date }>("lucchetti"))
    .updateOne({ _id: NOME_LUCCHETTO }, { $set: { preso: new Date() } })
    .catch(() => {});
}

async function lasciaLucchetto(): Promise<void> {
  await (await coll("lucchetti")).deleteOne({ _id: NOME_LUCCHETTO }).catch(() => {});
}

type DocStatoPilota = {
  _id: string;
  ultimoGiro: Date;
  messaggio: string;
  pubblicate: number;
  segnalate: number;
};

/** L'ultimo giro, per Supervisione: senza, un pilota fermo sarebbe invisibile. */
async function registraStato(e: EsitoGiro): Promise<void> {
  await (await coll<DocStatoPilota>("pilota"))
    .updateOne(
      { _id: "stato" },
      { $set: { ultimoGiro: new Date(e.quando), messaggio: e.messaggio, pubblicate: e.pubblicate, segnalate: e.segnalate } },
      { upsert: true },
    )
    .catch(() => {});
}

export type StatoPilota = { ultimoGiro: string; messaggio: string } | null;

export async function leggiStatoPilota(): Promise<StatoPilota> {
  const d = await (await coll<DocStatoPilota>("pilota")).findOne({ _id: "stato" });
  return d?.ultimoGiro ? { ultimoGiro: d.ultimoGiro.toISOString(), messaggio: d.messaggio ?? "" } : null;
}

/** Un giro parte ogni 5 minuti, anche fuori fascia: oltre questo silenzio il pilota è fermo. */
const PILOTA_VIVO_ENTRO_MS = 15 * 60 * 1000;

/**
 * Il pilota sta girando? Serve alla home per decidere se nascondere le
 * recensioni delle regole automatiche.
 *
 * Nasconderle SEMPRE sarebbe pericoloso: su un server senza AUTOPILOTA=1, o
 * col pilota piantato, sparirebbero da «Da approvare» senza che nessuno le
 * risponda mai. Il pilota invece lascia traccia a OGNI giro — anche fuori
 * fascia, anche quando non trova niente — quindi un ultimo giro recente è la
 * prova che è vivo. Se tace da più di 15 minuti le recensioni tornano visibili:
 * il lavoro non si perde.
 */
export async function pilotaVivo(ora: Date = new Date()): Promise<boolean> {
  const s = await leggiStatoPilota().catch(() => null);
  return s !== null && ora.getTime() - new Date(s.ultimoGiro).getTime() < PILOTA_VIVO_ENTRO_MS;
}

/** L'indirizzo del portale per il tasto nella mail: qui non c'è una richiesta da cui ricavarlo. */
function linkSupervisione(): string {
  const base = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "") || "http://localhost:4000";
  return `${base}/supervisione`;
}

/** Passa la recensione in Supervisione: segnalazione (una sola) + mail all'amministratore. */
async function passaInSupervisione(r: RecensioneArchiviata, nota: string): Promise<boolean> {
  const creata = await segnala(r, nota, OPERATORE_SISTEMA);
  if (!creata) return false; // era già segnalata: niente seconda mail
  const avviso = await avvisaAdminDiSegnalazione({
    recensione: r,
    nota,
    daChi: "L'automazione",
    link: linkSupervisione(),
  });
  console.log(
    `[pilota] «${r.nome}» passata in Supervisione${avviso.inviata ? "" : ` (mail non inviata: ${avviso.motivo})`}.`,
  );
  return true;
}

/**
 * Un giro del pilota. Non solleva mai: ritorna cosa è successo.
 *
 * `prova: true` fa tutto fino alla scelta delle candidate e si ferma lì — non
 * lancia il robot, non scrive niente se non la lettura della posta. Serve a
 * vedere cosa farebbe prima di accenderlo.
 */
export async function giroPilota(
  opts: {
    prova?: boolean;
    ora?: Date;
    /**
     * SOLO in prova: le regole da usare al posto di quelle salvate. Serve a
     * vedere cosa farebbe una configurazione PRIMA di accenderla (per esempio
     * le negative in automatico). Fuori dalla prova si ignora.
     */
    regole?: Regola[];
  } = {},
): Promise<EsitoGiro> {
  const ora = opts.ora ?? new Date();
  const esito: EsitoGiro = {
    quando: ora.toISOString(),
    messaggio: "",
    pubblicate: 0,
    segnalate: 0,
    giaRisposte: 0,
  };
  const fine = async (messaggio: string): Promise<EsitoGiro> => {
    esito.messaggio = messaggio;
    if (!opts.prova) await registraStato(esito);
    return esito;
  };

  try {
    // Le risposte del customer care: si cercano a OGNI giro, prima di qualunque
    // uscita anticipata (fuori fascia, nessuna regola automatica, simulazione).
    // Finché il pilota è vivo la home non le cerca più all'apertura di «In
    // attesa» — era il pezzo che costava 2,5 s a ogni clic sul tab — quindi se
    // il giro le saltasse, le risposte non arriverebbero mai.
    if (!opts.prova && (await isGraphConfigured())) {
      const trovate = await aggiornaAttese().catch((e) => {
        console.warn("[pilota] ricerca risposte del customer care saltata:", e instanceof Error ? e.message : e);
        return 0;
      });
      if (trovate > 0) console.log(`[pilota] risposte del customer care arrivate: ${trovate}.`);
    }

    const regole = opts.prova && opts.regole ? opts.regole : await caricaRegole();
    const attive = regole.filter((r) => r.attiva);
    const { giorno, oraDecimale } = adessoARoma(ora);

    const automatiche = attive.filter((r) => automazioneDi(r).modo !== "manuale");
    if (automatiche.length === 0) return await fine("Nessuna regola in automatico.");
    for (const r of automatiche.filter(
      (x) => !regolaAutomatizzabile(x) && !regolaEscalationAutomatizzabile(x),
    )) {
      console.warn(
        `[pilota] regola «${r.id}» in automatico ma NON automatizzabile (serve «senza testo» 4-5★, o l'escalation 1-2★): ignorata.`,
      );
    }
    // Le due famiglie (vedi in cima) e i loro orologi.
    const positive = automatiche.filter(regolaAutomatizzabile);
    const negative = automatiche.filter(regolaEscalationAutomatizzabile);
    const inFascia = (r: Regola) => dentroFascia(automazioneDi(r), giorno, oraDecimale);
    const pubblicaInFascia = [...positive, ...negative].filter(inFascia);

    // Niente inoltri da fare e fuori fascia per pubblicare: il giro finisce qui,
    // come sempre. Con le negative in automatico invece si va avanti a qualunque
    // ora, perché l'inoltro a Cherubina parte subito.
    if (negative.length === 0 && pubblicaInFascia.length === 0 && !opts.prova) {
      return await fine("Fuori fascia oraria: in pausa.");
    }

    if (!opts.prova && (await modoOperativo()) !== "reale") {
      return await fine("Modalità simulazione: il pilota non pubblica.");
    }

    if (!opts.prova && !(await prendiLucchetto())) {
      return { ...esito, messaggio: "Un altro giro è già in corso." };
    }
    try {
      // Posta nuova in archivio: senza, se nessuno apre il portale le recensioni
      // non arriverebbero mai. Cache di 3 minuti, come la home.
      const label = (await loadSettings()).labels[0] ?? null;
      if (label && (await isGraphConfigured())) {
        await caricaRecensioni(label, { top: 100 }).catch((e) =>
          console.warn("[pilota] lettura posta non riuscita:", e instanceof Error ? e.message : e),
        );
      }
      // Le chiusure Freshdesk programmate girano solo quando qualcuno apre la
      // home: in automatico nessuno la apre, quindi le ritenta il pilota.
      if (!opts.prova) await ritentaChiusureInSospeso().catch(() => 0);

      const [recensioni, pubblicate, archiviate, segnalate, inCiclo, conEscalation, esaurite] =
        await Promise.all([
          recensioniDaApprovare(),
          chiaviPubblicate(),
          chiaviArchiviate(),
          chiaviSegnalate(),
          chiaviInCiclo(),
          chiaviConEscalation(),
          chiaviAutomazioneEsaurita(),
        ]);
      // Qualunque segno che qualcuno ci abbia già messo le mani: lasciata stare.
      const giaToccata = (r: RecensioneArchiviata) =>
        r.haRisposta ||
        r.risolto ||
        Boolean(r.ticketConfermato) ||
        pubblicate.has(r.chiave) ||
        archiviate.has(r.chiave) ||
        segnalate.has(r.chiave) ||
        esaurite.has(r.chiave);
      const candidate: NonNullable<EsitoGiro["candidate"]> = [];
      let fermato = "";

      /**
       * Un tentativo andato male. Il primo si ripete al giro dopo; al secondo la
       * recensione va in Supervisione, con TUTTI i motivi — chi la apre deve
       * poter capire senza leggere i log.
       */
      const fallito = async (fase: FasePilota, r: RecensioneArchiviata, perche: string) => {
        const t = await registraTentativoFallito(fase, r.chiave, perche);
        const cosa =
          fase === "inoltro"
            ? "l'inoltro al customer care"
            : "la pubblicazione della risposta del customer care";
        if (t.n >= MAX_TENTATIVI) {
          const elenco = t.errori.map((e, i) => `${i + 1}) ${e}`).join(" ");
          const nota = `🤖 Automazione: ${cosa} è fallito ${t.n} volte. ${elenco}`;
          if (await passaInSupervisione(r, nota.slice(0, 1000))) esito.segnalate++;
        } else {
          esito.daRiprovare = (esito.daRiprovare ?? 0) + 1;
          console.log(
            `[pilota] «${r.nome}»: ${cosa} non riuscito (tentativo ${t.n} di ${MAX_TENTATIVI}), riprovo al prossimo giro — ${perche}`,
          );
        }
      };

      // ===================================================== FASE 1: inoltri
      // Subito, a qualunque ora, senza ritardo: niente robot e niente Chrome,
      // quindi niente fascia. Solo le negative mai toccate da nessuno.
      if (negative.length > 0) {
        const perIdNeg = new Map(negative.map((r) => [r.id, r]));
        let daInoltrare: { r: RecensioneArchiviata; regola: Regola }[] = [];
        for (const r of recensioni) {
          if (giaToccata(r) || conEscalation.has(r.chiave)) continue;
          const regola = regolaPer(attive, r.stelle, haTesto(r));
          if (regola && perIdNeg.has(regola.id)) daInoltrare.push({ r, regola });
        }

        // Freshdesk: un ticket che esiste già vuol dire che qualcuno l'ha già
        // inoltrata (a mano, da un'altra casella). È la stessa prova con cui la
        // home smette di riproporre l'inoltro. Se Freshdesk non risponde, niente
        // inoltri in questo giro: meglio cinque minuti di ritardo che un doppione.
        if (daInoltrare.length > 0) {
          let tickets;
          try {
            tickets = await elencoTicketRecenti(6);
          } catch (e) {
            console.warn("[pilota] Freshdesk non risponde, inoltri rimandati:", e instanceof Error ? e.message : e);
            daInoltrare = [];
          }
          if (tickets) {
            const sweep = await recensioniConTicket(
              daInoltrare.map((x) => ({
                chiave: x.r.chiave,
                oggetto: x.r.oggetto,
                ricevutaIl: x.r.ricevutaIl,
                nome: x.r.nome,
              })),
              { tickets },
            );
            if (sweep.errore) {
              console.warn(`[pilota] verifica dei ticket incompleta (${sweep.errore}): inoltri rimandati.`);
              daInoltrare = [];
            } else {
              if (sweep.conferme.length > 0 && !opts.prova) await confermaTicket(sweep.conferme).catch(() => 0);
              daInoltrare = daInoltrare.filter((x) => !sweep.nascoste.has(x.r.chiave));
            }
          }
        }

        daInoltrare.sort((a, b) => new Date(a.r.ricevutaIl).getTime() - new Date(b.r.ricevutaIl).getTime());
        for (const { r, regola } of daInoltrare) {
          if (opts.prova) {
            candidate.push({ nome: r.nome, stelle: r.stelle, regola: regola.id, ricevutaIl: r.ricevutaIl, fase: "inoltro" });
            continue;
          }
          await rinnovaLucchetto();
          try {
            const f = await inoltraERegistra({
              recensione: r,
              regola,
              operatoreId: OPERATORE_SISTEMA,
              soloSeInoltrata: true,
            });
            if (!f.registrata) {
              await fallito("inoltro", r, f.perche);
              continue;
            }
            esito.inoltrate = (esito.inoltrate ?? 0) + 1;
            await registraAttivita("pilota.inoltrata", {
              operatoreId: OPERATORE_SISTEMA,
              oggettoTipo: "recensione",
              oggettoId: r.chiave,
              dettaglio: `Inoltrata al customer care · regola ${regola.id}`,
            });
            // La mail è partita ma un passaggio su Freshdesk no (classificazione,
            // tag, assegnazione): Cherubina l'ha ricevuta, quindi l'attesa è
            // registrata e il ciclo va avanti. Resta scritto nell'esecuzione.
            const rotto = f.esecuzione.nodi.find((n) => n.stato === "errore");
            if (rotto) {
              console.warn(`[pilota] «${r.nome}» inoltrata, ma «${rotto.titolo}» è fallito: ${rotto.messaggio}`);
            }
          } catch (errore) {
            await fallito("inoltro", r, errore instanceof Error ? errore.message : String(errore));
          }
        }
      }

      // Riassunto di ciò che si è fatto finora, per le uscite che seguono.
      const giaFatto = () =>
        esito.inoltrate ? `Inoltrate al customer care ${esito.inoltrate}. ` : "";

      // ============================================= il ROBOT: solo in fascia
      if (pubblicaInFascia.length === 0 && !opts.prova) {
        return await fine(`${giaFatto()}Fuori fascia per le pubblicazioni: in pausa.`);
      }
      if (!opts.prova && robotOccupato()) return await fine(`${giaFatto()}Robot occupato: riprovo al giro dopo.`);
      if (!opts.prova && chromeInEsecuzione()) {
        return await fine(`${giaFatto()}Chrome aperto sul server: il robot non può partire, riprovo al giro dopo.`);
      }

      // --- FASE 2: le risposte di Cherubina, pronte da pubblicare ------------
      // In fascia ma SENZA ritardo: la risposta è arrivata, il cliente aspetta
      // già da giorni. Dalla più vecchia.
      const negativeDaPubblicare = opts.prova ? negative : negative.filter(inFascia);
      const daPubblicareCC: { r: RecensioneArchiviata; regola: Regola; testo: string; blocco: string | null }[] = [];
      if (negativeDaPubblicare.length > 0) {
        const perIdNeg = new Map(negativeDaPubblicare.map((r) => [r.id, r]));
        const pronte = (await elencoPronte()).sort(
          (a, b) => new Date(a.rispostaTrovataIl ?? a.aggiornataIl).getTime() - new Date(b.rispostaTrovataIl ?? b.aggiornataIl).getTime(),
        );
        for (const p of pronte) {
          if (pubblicate.has(p.chiave) || archiviate.has(p.chiave) || segnalate.has(p.chiave)) continue;
          if (esaurite.has(p.chiave)) continue;
          const r = await leggiRecensione(p.chiave);
          if (!r) continue;
          const regola = regolaPer(attive, r.stelle, haTesto(r));
          if (!regola || !perIdNeg.has(regola.id)) continue;
          const testo = (p.rispostaTesto ?? "").trim();
          daPubblicareCC.push({ r, regola, testo, blocco: motivoPerNonPubblicare(testo, r.nome) });
        }
      }

      // --- le POSITIVE, come sempre -------------------------------------------
      const positiveDaUsare = opts.prova ? positive : positive.filter(inFascia);
      const perIdPos = new Map(positiveDaUsare.map((r) => [r.id, r]));
      let daRispondere: { r: RecensioneArchiviata; regola: Regola }[] = [];
      for (const r of recensioni) {
        if (giaToccata(r) || inCiclo.has(r.chiave)) continue;
        // La regola che la copre DAVVERO (la prima attiva, come nella home).
        const regola = regolaPer(attive, r.stelle, haTesto(r));
        if (!regola || !perIdPos.has(regola.id)) continue;
        const a = automazioneDi(regola);
        const arrivata = new Date(r.ricevutaIl).getTime();
        if (arrivata > ora.getTime() - a.ritardoMinuti * 60_000) continue; // non ancora il suo momento
        daRispondere.push({ r, regola });
      }

      // Freshdesk: un ticket già RISOLTO vuol dire che qualcuno l'ha gestita fuori
      // dal portale. Senza la lista dei ticket non si può escludere, quindi non
      // si pubblica niente in questo giro: meglio un giro perso che una doppia risposta.
      if (daRispondere.length > 0) {
        let tickets;
        try {
          tickets = await elencoTicketRecenti(6);
        } catch (e) {
          return await fine(
            `${giaFatto()}Freshdesk non risponde (${e instanceof Error ? e.message : e}): nessuna pubblicazione, riprovo.`,
          );
        }
        const sweep = await recensioniConTicketRisolto(
          daRispondere.map((x) => ({
            chiave: x.r.chiave,
            oggetto: x.r.oggetto,
            ricevutaIl: x.r.ricevutaIl,
            nome: x.r.nome,
          })),
          { tickets },
        );
        if (sweep.conferme.length > 0 && !opts.prova) await confermaTicket(sweep.conferme).catch(() => 0);
        daRispondere = daRispondere.filter((x) => !sweep.nascoste.has(x.r.chiave));
      }
      // Dalla più vecchia: chi aspetta da più tempo passa prima.
      daRispondere.sort((a, b) => new Date(a.r.ricevutaIl).getTime() - new Date(b.r.ricevutaIl).getTime());

      if (opts.prova) {
        for (const x of daPubblicareCC) {
          candidate.push({
            nome: x.r.nome,
            stelle: x.r.stelle,
            regola: x.regola.id,
            ricevutaIl: x.r.ricevutaIl,
            fase: "risposta-customer-care",
            bloccata: x.blocco ?? undefined,
          });
        }
        for (const x of daRispondere) {
          candidate.push({ nome: x.r.nome, stelle: x.r.stelle, regola: x.regola.id, ricevutaIl: x.r.ricevutaIl, fase: "risposta" });
        }
        esito.candidate = candidate;
        const conta = (f: string) => candidate.filter((c) => c.fase === f).length;
        return await fine(
          `Prova: ${conta("inoltro")} da inoltrare, ${conta("risposta-customer-care")} risposte del customer care da pubblicare, ${conta("risposta")} positive da rispondere.`,
        );
      }
      if (daPubblicareCC.length === 0 && daRispondere.length === 0) {
        return await fine(`${giaFatto()}Nessuna recensione da pubblicare.`);
      }

      /** Prima di OGNI pubblicazione: fascia, robot, Chrome. Un giro dura minuti. */
      const puoContinuare = (regola: Regola): boolean => {
        const adesso = adessoARoma(new Date());
        if (!dentroFascia(automazioneDi(regola), adesso.giorno, adesso.oraDecimale)) {
          fermato = "la fascia oraria si è chiusa";
          return false;
        }
        if (robotOccupato()) {
          fermato = "il robot è stato occupato da qualcun altro";
          return false;
        }
        if (chromeInEsecuzione()) {
          fermato = "si è aperto Chrome sul server";
          return false;
        }
        return true;
      };

      // --- il lavoro: prima le risposte di Cherubina (il cliente aspetta da
      // giorni, e sono quelle che lei segnala come prioritarie), poi le positive.
      for (const { r, regola, testo, blocco } of daPubblicareCC) {
        if (!puoContinuare(regola)) break;
        await rinnovaLucchetto();

        // Il testo non passa il controllo: NON si pubblica e non si ritenta —
        // riprovare non lo cambierebbe. Va a una persona subito.
        if (blocco) {
          const nota = `🤖 Automazione: la risposta del customer care NON è stata pubblicata, perché ${blocco}. Testo: «${testo.slice(0, 400)}»`;
          if (await passaInSupervisione(r, nota.slice(0, 1000))) esito.segnalate++;
          continue;
        }

        try {
          const e = await rispondiERegistra({
            recensione: r,
            regola,
            testo,
            riscritto: null,
            operatoreId: OPERATORE_SISTEMA,
            operatoreNome: "Sistema",
            metodo: "automatico",
          });
          if (e.tipo === "vuoto") {
            await fallito("pubblicazione", r, "nessun testo da pubblicare");
            continue;
          }
          if (e.tipo === "google-ko") {
            // Il robot occupato non è un errore della recensione: si riprova dopo.
            if (e.robot.stato === "occupato") {
              fermato = "il robot è stato occupato da qualcun altro";
              break;
            }
            // Su Google la risposta c'è già: qualcuno l'ha pubblicata a mano.
            // È gestita, non in errore: si chiude, ed esce dal ciclo escalation.
            if (/ha già una risposta/i.test(e.robot.messaggio)) {
              await segnaGestitaFuoriPortale(
                r.chiave,
                "🤖 Automazione: su Google la recensione aveva già una risposta. Chiusa senza pubblicare niente.",
              );
              await segnaChiusa(r.chiave);
              esito.giaRisposte++;
              continue;
            }
            await fallito("pubblicazione", r, `${e.robot.stato}: ${e.robot.messaggio}`);
            // Senza sessione Google falliranno tutte allo stesso modo: inutile insistere.
            if (e.robot.stato === "non-loggato") break;
            continue;
          }

          esito.pubblicate++;
          await registraAttivita("pilota.pubblicata", {
            operatoreId: OPERATORE_SISTEMA,
            oggettoTipo: "recensione",
            oggettoId: r.chiave,
            dettaglio: `Risposta del customer care pubblicata · regola ${regola.id}`,
          });
        } catch (errore) {
          const msg = errore instanceof Error ? errore.message : String(errore);
          console.error(`[pilota] «${r.nome}»: ${msg}`);
          await fallito("pubblicazione", r, `errore imprevisto — ${msg}`);
        }
      }

      for (const { r, regola } of fermato ? [] : daRispondere) {
        if (!puoContinuare(regola)) break;
        await rinnovaLucchetto();

        // Lo stesso testo che la card mostrerebbe: quello della regola, nella
        // lingua decisa dal nome. Così un ritocco al testo in Impostazioni vale
        // anche qui.
        const nodo = regola.azioni.find((x) => x.tipo === "google.rispondi");
        const lingua = await linguaRispostaIA(r.lingua, r.originale, r.nome);
        const testo = nodo ? testoPerRecensioneConLingua(nodo, r, lingua).testo : "";

        try {
          const e = await rispondiERegistra({
            recensione: r,
            regola,
            testo,
            riscritto: null,
            operatoreId: OPERATORE_SISTEMA,
            operatoreNome: "Sistema",
            metodo: "automatico",
          });

          if (e.tipo === "vuoto") {
            if (await passaInSupervisione(r, "🤖 Automazione: la regola non ha un testo da pubblicare.")) esito.segnalate++;
            continue;
          }
          if (e.tipo === "google-ko") {
            // Il robot occupato non è un errore della recensione: si riprova dopo.
            if (e.robot.stato === "occupato") {
              fermato = "il robot è stato occupato da qualcun altro";
              break;
            }
            // Su Google la risposta c'è già (data a mano, prima che arrivasse il
            // pilota): la recensione è GESTITA, non in errore. Si chiude come le
            // gestite fuori dal portale — risulta risposta e va in «Archiviate»
            // col motivo, dove si può ripristinare — invece di aprire una
            // segnalazione per una cosa che non chiede niente a nessuno.
            if (/ha già una risposta/i.test(e.robot.messaggio)) {
              await segnaGestitaFuoriPortale(
                r.chiave,
                "🤖 Automazione: su Google la recensione aveva già una risposta. Chiusa senza pubblicare niente.",
              );
              esito.giaRisposte++;
              continue;
            }
            const nota = `🤖 Automazione: il robot non ha pubblicato su Google (${e.robot.stato}). ${e.robot.messaggio}`;
            if (await passaInSupervisione(r, nota.slice(0, 1000))) esito.segnalate++;
            // Senza sessione Google falliranno tutte allo stesso modo: inutile insistere.
            if (e.robot.stato === "non-loggato") break;
            continue;
          }

          esito.pubblicate++;
          await registraAttivita("pilota.pubblicata", {
            operatoreId: OPERATORE_SISTEMA,
            oggettoTipo: "recensione",
            oggettoId: r.chiave,
            dettaglio: `«${testo}» · regola ${regola.id}`,
          });
          // Pubblicata, ma un passaggio dopo Google è andato storto (email,
          // Freshdesk): il cliente ha la risposta, però va guardata.
          const rotto = e.esecuzione.nodi.find((n) => n.stato === "errore");
          if (rotto) {
            const nota = `🤖 Automazione: PUBBLICATA su Google, ma il passaggio «${rotto.titolo}» è fallito: ${rotto.messaggio}`;
            if (await passaInSupervisione(r, nota.slice(0, 1000))) esito.segnalate++;
          }
        } catch (errore) {
          const msg = errore instanceof Error ? errore.message : String(errore);
          console.error(`[pilota] «${r.nome}»: ${msg}`);
          if (await passaInSupervisione(r, `🤖 Automazione: errore imprevisto — ${msg}`.slice(0, 1000))) esito.segnalate++;
        }
      }

      return await fine(
        `${giaFatto()}Pubblicate ${esito.pubblicate}, passate in Supervisione ${esito.segnalate}` +
          (esito.daRiprovare ? `, da riprovare ${esito.daRiprovare}` : "") +
          (esito.giaRisposte > 0 ? `, già risposte su Google ${esito.giaRisposte}` : "") +
          (fermato ? ` — fermo perché ${fermato}, riprendo al prossimo giro.` : "."),
      );
    } finally {
      if (!opts.prova) await lasciaLucchetto();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[pilota] giro interrotto:", msg);
    return await fine(`Giro interrotto: ${msg}`);
  }
}

/** Ogni quanto gira il pilota. La fascia e il ritardo li decide la regola, non questo. */
export const INTERVALLO_PILOTA_MS = 5 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __galdieriPilota: NodeJS.Timeout | undefined;
}

/**
 * Accende il pilota nel processo del server. Una volta sola per processo (la
 * guardia su globalThis regge anche all'hot-reload), e mai due giri
 * sovrapposti: se un giro dura più dell'intervallo, il successivo salta.
 *
 * Gira DENTRO il server Next e non in uno script a parte per un motivo
 * preciso: il lucchetto «un robot per volta» vive in memoria in questo
 * processo. Da un processo separato il pilota e il tasto «Rispondi» potrebbero
 * aprire due Chrome sullo stesso profilo.
 */
export function avviaPilota(): void {
  if (globalThis.__galdieriPilota) return;
  let inCorso = false;
  const giro = async () => {
    if (inCorso) return;
    inCorso = true;
    try {
      const e = await giroPilota();
      if (e.pubblicate > 0 || e.segnalate > 0 || (e.inoltrate ?? 0) > 0 || (e.daRiprovare ?? 0) > 0) {
        console.log(`[pilota] ${e.messaggio}`);
      }
    } finally {
      inCorso = false;
    }
  };
  globalThis.__galdieriPilota = setInterval(giro, INTERVALLO_PILOTA_MS);
  setTimeout(giro, 60_000); // il primo giro un minuto dopo l'avvio, a server già in piedi
  console.log("[pilota] acceso: un giro ogni 5 minuti.");
}
