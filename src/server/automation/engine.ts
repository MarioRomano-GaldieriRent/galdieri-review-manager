import { eseguiAzione, type Contesto } from "./connectors";
import { CATALOGO, type Esecuzione, type EsitoNodo, type Regola, type StatoNodo } from "./types";
import { modoOperativo, resolveAutomation } from "@/server/settings";
import { testoRecensione, type Recensione } from "@/server/reviews/load";

// Esecuzione di una regola su una singola recensione.
//
// I nodi girano in sequenza e ognuno registra il proprio esito: si vede quale
// è andato a buon fine, quale è stato saltato e quale ha fallito. Un nodo che
// fallisce ferma il flusso — come farebbe una persona che si accorge di un
// problema a metà lavoro.

let contatore = 0;

function nuovoId(): string {
  contatore += 1;
  return `run-${Date.now().toString(36)}-${contatore}`;
}

/**
 * Testo riscritto a mano prima di eseguire.
 *
 * Il testo mostrato nella dashboard è già stato scelto nella lingua giusta, per
 * questo la riscrittura sostituisce sia la versione italiana sia quella
 * inglese: quello che si legge è quello che parte, senza sorprese.
 */
export type TestoRiscritto = { azioneId: string; testo: string };

export async function eseguiRegola(
  regola: Regola,
  recensione: Recensione,
  riscritto?: TestoRiscritto | null,
): Promise<Esecuzione> {
  const modo = await modoOperativo();
  const automation = await resolveAutomation();

  const ctx: Contesto = { recensione, ticket: null, automation };
  const nodi: EsitoNodo[] = [];
  let esito: "ok" | "errore" = "ok";
  let interrotto = false;
  let modificato = false;

  for (const originale of regola.azioni) {
    const daRiscrivere = riscritto && riscritto.azioneId === originale.id;
    if (daRiscrivere) modificato = true;
    const azione = daRiscrivere
      ? {
          ...originale,
          parametri: {
            ...originale.parametri,
            testo: riscritto.testo,
            testoInglese: riscritto.testo,
          },
        }
      : originale;

    const meta = CATALOGO[azione.tipo];
    const inizio = Date.now();

    if (interrotto) {
      nodi.push({
        azioneId: azione.id,
        tipo: azione.tipo,
        servizio: meta.servizio,
        titolo: meta.titolo,
        stato: "saltato",
        messaggio: "Non eseguito: il flusso si è fermato al nodo precedente.",
        chiamata: null,
        durataMs: 0,
      });
      continue;
    }

    try {
      const r = await eseguiAzione(azione, ctx);
      if (r.ticket !== undefined) ctx.ticket = r.ticket;

      let stato: StatoNodo;
      if (r.saltato) stato = "saltato";
      else if (r.eseguita) stato = "ok";
      else if (meta.scrittura) stato = "simulato";
      else stato = "ok";

      nodi.push({
        azioneId: azione.id,
        tipo: azione.tipo,
        servizio: meta.servizio,
        titolo: meta.titolo,
        stato,
        messaggio: r.messaggio,
        chiamata: r.chiamata,
        durataMs: Date.now() - inizio,
      });
    } catch (e) {
      esito = "errore";
      interrotto = true;
      nodi.push({
        azioneId: azione.id,
        tipo: azione.tipo,
        servizio: meta.servizio,
        titolo: meta.titolo,
        stato: "errore",
        messaggio: e instanceof Error ? e.message : "Errore sconosciuto",
        chiamata: null,
        durataMs: Date.now() - inizio,
      });
    }
  }

  return {
    id: nuovoId(),
    quando: new Date().toISOString(),
    modo,
    regolaId: regola.id,
    regolaNome: regola.nome,
    recensione: {
      chiave: recensione.chiave,
      nome: recensione.nome,
      stelle: recensione.stelle,
      sede: recensione.sede,
      testo: testoRecensione(recensione).slice(0, 400),
    },
    nodi,
    esito,
    testoModificato: modificato,
  };
}
