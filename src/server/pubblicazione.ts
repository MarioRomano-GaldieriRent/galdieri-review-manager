import {
  codaDaRicontrollare,
  leggiPubblicazione,
  segnaEsitoFreshdesk,
  type VocePubblicazione,
} from "@/server/db/pubblicazioni";
import { coll } from "@/server/db/connessione";
import {
  chiudiTicketPubblicato,
  testoNotaPubblicazione,
} from "@/server/integrations/freshdeskChiusura";
import { tagSede } from "@/server/automation/sedi";

// Orchestrazione della chiusura Freshdesk per una risposta pubblicata a mano.
//
// Lega tre pezzi: lo stato della coda (db/pubblicazioni), l'adapter di
// scrittura (integrations/freshdeskChiusura) e il tag della sede
// (automation/sedi). Tiene la coda di retry: un errore Freshdesk non blocca
// l'operatore, la chiusura si ritenta più tardi.

/** Dopo tre tentativi falliti non si ritenta più da soli: resta il pulsante manuale. */
export const MAX_TENTATIVI_FRESHDESK = 3;

/**
 * Ritardo tra APERTURA e RISOLUZIONE del ticket, sui casi positivi (5★/4★) dove
 * l'apertura e la chiusura avverrebbero nella stessa richiesta, a pochi secondi.
 * Risolvere così in fretta rischia di non dare a Freshdesk il tempo di far
 * partire le sue comunicazioni via email: si programma la risoluzione a +N min e
 * la esegue la passata ritentaChiusureInSospeso() a un ricarico successivo della
 * home (di fatto: sessione chiusa e riaperta). Le NEGATIVE non passano di qui —
 * il loro ticket è già aperto da giorni quando si pubblica la risposta.
 */
export const RITARDO_RISOLUZIONE_MIN = 15;

/**
 * Programma (non esegue) la risoluzione del ticket a +ritardo minuti: mette la
 * pubblicazione in coda «in attesa» con tentativi=0. La distingue da un retry
 * dopo errore proprio il fatto che i tentativi siano ancora 0. La sweep
 * ritentaChiusureInSospeso() la prenderà quando prossimoTentativoIl è passato.
 */
export async function programmaChiusuraFreshdesk(
  chiave: string,
  ritardoMinuti: number = RITARDO_RISOLUZIONE_MIN,
): Promise<void> {
  await segnaEsitoFreshdesk(chiave, "inattesa", {
    tentativi: 0,
    prossimoTentativoIl: new Date(Date.now() + ritardoMinuti * 60 * 1000),
  });
}

/** Attesa prima del prossimo tentativo: 2, 4, 8 minuti. */
function prossimoTentativo(tentativi: number): Date {
  const minuti = Math.min(2 ** tentativi, 30);
  return new Date(Date.now() + minuti * 60 * 1000);
}

/**
 * Chiude il ticket collegato a una pubblicazione e registra come è andata.
 * Non solleva: l'esito finisce sul documento, la coda di retry fa il resto.
 */
export async function chiudiFreshdeskPer(
  voce: VocePubblicazione,
  operatoreNome = "Sistema",
): Promise<void> {
  if (voce.ticketId == null) {
    await segnaEsitoFreshdesk(voce.chiave, "fallito", {
      errore: "nessun ticket collegato alla recensione",
      tentativi: voce.freshdeskTentativi,
      prossimoTentativoIl: null,
    });
    return;
  }

  const nota = testoNotaPubblicazione(
    operatoreNome,
    voce.pubblicataIl ? new Date(voce.pubblicataIl) : new Date(),
    voce.testoRisposta,
  );
  const esito = await chiudiTicketPubblicato(voce.ticketId, {
    tagSede: tagSede(voce.sedeNome),
    nota,
    stelle: voce.stelle,
  });

  if (esito.stato === "eseguita") {
    await segnaEsitoFreshdesk(voce.chiave, "ok", { tentativi: voce.freshdeskTentativi });
    return;
  }
  if (esito.stato === "simulata") {
    // In simulazione non si è scritto nulla: l'esito resta neutro.
    await segnaEsitoFreshdesk(voce.chiave, "noniniziato", { tentativi: voce.freshdeskTentativi });
    return;
  }

  // fallita: si accoda a retry finché non si esauriscono i tentativi.
  const tentativi = voce.freshdeskTentativi + 1;
  const esaurito = tentativi >= MAX_TENTATIVI_FRESHDESK;
  await segnaEsitoFreshdesk(voce.chiave, esaurito ? "fallito" : "inattesa", {
    errore: esito.errore,
    tentativi,
    prossimoTentativoIl: esaurito ? null : prossimoTentativo(tentativi),
  });
}

/** Ritenta ora una singola chiusura in sospeso (dal pulsante "riprova"). */
export async function ritentaChiusura(chiave: string, operatoreNome = "Sistema"): Promise<void> {
  const voce = await leggiPubblicazione(chiave);
  if (voce && (voce.freshdeskEsito === "inattesa" || voce.freshdeskEsito === "fallito")) {
    await chiudiFreshdeskPer(voce, operatoreNome);
  }
}

/**
 * Ritenta le chiusure in sospeso il cui momento è arrivato. Best-effort:
 * la si chiama all'apertura della coda, non c'è uno scheduler dedicato.
 * Ritorna quante ne ha ritentate.
 */
export async function ritentaChiusureInSospeso(operatoreNome = "Sistema"): Promise<number> {
  const ora = new Date();
  const dovute = (await (
    await coll("pubblicazioni")
  )
    .find({ freshdeskEsito: "inattesa", freshdeskProssimoTentativoIl: { $lte: ora } })
    .project({ _id: 1 })
    .limit(20)
    .toArray()) as { _id: string }[];

  let fatti = 0;
  for (const { _id } of dovute) {
    const voce = await leggiPubblicazione(_id);
    if (!voce) continue;
    await chiudiFreshdeskPer(voce, operatoreNome);
    fatti++;
  }
  return fatti;
}

/** Le pubblicazioni il cui ricontrollo a +24h è scaduto (per un eventuale avviso). */
export async function ricontrolliScaduti(): Promise<VocePubblicazione[]> {
  const ora = Date.now();
  const tutte = await codaDaRicontrollare();
  return tutte.filter(
    (v) => v.promemoriaVerificaIl && new Date(v.promemoriaVerificaIl).getTime() <= ora,
  );
}
