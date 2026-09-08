"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { richiediOperatore } from "@/server/auth/sessione";
import { eseguiRegola } from "@/server/automation/engine";
import {
  AGENTE_ESCALATION,
  EMAIL_ESCALATION,
  EMAIL_TICKETING,
  REGOLA_ESCALATION_12,
  TESTO_ESCALATION,
  TIPO_TICKET_GMB,
  caricaRegole,
  conBeta,
  regolaPer,
} from "@/server/automation/rules";
import { registraEsecuzione } from "@/server/automation/runs";
import type { Azione, Regola } from "@/server/automation/types";
import { leggiEscalation, registraInoltro } from "@/server/db/escalation";
import { leggiRecensione } from "@/server/db/recensioni";
import { haTesto } from "@/server/reviews/load";

// «Inoltra al customer care» sulle card che hanno ANCHE il box di risposta —
// le 3★, l'ibrido: l'operatore sceglie se rispondere lei o passare la
// recensione a Cherubina. La regola della recensione qui NON si esegue: è
// quella della risposta diretta, e farla partire manderebbe il «Grazie.».
// Si esegue invece la Fase 1 dell'escalation, la stessa delle 1-2★: inoltro
// (col CC che apre il ticket), aggancio, classifica, tag, assegnazione, attesa.
// Poi la recensione entra in «In attesa» come una negativa qualsiasi e, quando
// Cherubina rimanda il testo, torna in «Da approvare» precompilata: da lì
// «Rispondi» è la Fase 2 (playAction la riconosce dall'escalation registrata).

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function esito(chiave: string, ok: boolean, messaggio: string): never {
  const p = new URLSearchParams({
    esitoChiave: chiave,
    esitoOk: ok ? "1" : "0",
    esitoMsg: messaggio.slice(0, 240),
  });
  redirect(`/?${p}`);
}

const haInoltro = (r: Regola | null | undefined): r is Regola =>
  Boolean(r?.azioni.some((a) => a.tipo === "email.inoltra"));

/** I nodi fino all'attesa inclusa (tutti, se l'attesa non c'è). */
function faseUno(azioni: Azione[]): Azione[] {
  const i = azioni.findIndex((a) => a.tipo === "sistema.attendiRisposta");
  return i >= 0 ? azioni.slice(0, i + 1) : azioni;
}

/** «{stelle}» nei parametri: il connettore Freshdesk non lo interpola. */
function conStelle(azioni: Azione[], stelle: number | null): Azione[] {
  const s = stelle === null ? "" : String(stelle);
  return azioni.map((a) => ({
    ...a,
    parametri: Object.fromEntries(
      Object.entries(a.parametri).map(([k, v]) => [k, v.replace(/\{stelle\}/g, s)]),
    ),
  }));
}

/** L'ultima rete: se nel DB manca la regola 1-2★, si inoltra così. */
const FASE_UNO_MINIMA: Azione[] = [
  {
    id: "x1",
    tipo: "email.inoltra",
    parametri: { a: EMAIL_ESCALATION, cc: EMAIL_TICKETING, testo: TESTO_ESCALATION },
  },
  { id: "x2", tipo: "freshdesk.trovaTicket", parametri: {} },
  {
    id: "x3",
    tipo: "freshdesk.classifica",
    parametri: { tipo: TIPO_TICKET_GMB, specifica1: "negativa", specifica2: "{stelle} stelle" },
  },
  { id: "x4", tipo: "freshdesk.tag", parametri: { tag: "{sede}" } },
  { id: "x5", tipo: "freshdesk.assegna", parametri: { agenteId: AGENTE_ESCALATION } },
  { id: "x6", tipo: "sistema.attendiRisposta", parametri: { da: EMAIL_ESCALATION } },
];

export async function inoltraAlCustomerCareAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const chiave = str(formData, "chiave");
  if (!chiave) redirect("/");
  const recensione = await leggiRecensione(chiave);
  if (!recensione) redirect("/?errore=recensione-non-trovata");

  // Un solo inoltro per recensione: la seconda volta non si rimanda niente.
  const gia = await leggiEscalation(chiave);
  if (gia?.stato === "attesa") {
    esito(chiave, false, "Già inoltrata al customer care: la trovi nel tab «In attesa».");
  }
  if (gia?.stato === "pronta") {
    esito(chiave, false, "La risposta del customer care è già tornata: pubblicala con «Rispondi».");
  }

  // Da dove viene la Fase 1: dalla regola della recensione se è lei a prevedere
  // l'inoltro (le 1-2★); altrimenti dalla regola 1-2★ del DB — così se la si
  // cambia da Impostazioni cambia anche l'inoltro delle 3★; come ultima rete il
  // flusso minimo scritto qui sopra.
  const regole = conBeta(await caricaRegole(), op.regoleBeta ?? []);
  const propria = regolaPer(regole, recensione.stelle, haTesto(recensione));
  const dodici = regole.find((r) => r.id === REGOLA_ESCALATION_12);
  const base = haInoltro(propria) ? propria.azioni : haInoltro(dodici) ? dodici.azioni : FASE_UNO_MINIMA;

  const inoltro: Regola = {
    id: "inoltro-customer-care",
    nome: "Inoltro al customer care",
    attiva: true,
    condizione: { stelle: [1, 2, 3, 4, 5], testo: "qualsiasi" },
    azioni: conStelle(faseUno(base), recensione.stelle),
  };

  const esecuzione = await eseguiRegola(inoltro, recensione);
  await registraEsecuzione(esecuzione);

  // Il ticket, se il nodo l'ha agganciato, dal suo messaggio (#id).
  const nodoTicket = esecuzione.nodi.find((n) => n.tipo === "freshdesk.trovaTicket");
  const m = nodoTicket?.messaggio.match(/#(\d+)/);
  await registraInoltro(recensione, { ticketId: m ? Number(m[1]) : null, operatoreId: op._id });

  revalidatePath("/");
  redirect(`/?run=${encodeURIComponent(esecuzione.id)}`);
}
