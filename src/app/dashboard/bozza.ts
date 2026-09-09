"use server";

import { richiediOperatore } from "@/server/auth/sessione";
import { salvaBozza } from "@/server/db/bozze";

// Salvataggio automatico del riquadro di risposta, chiamato dal campo mentre si
// scrive (a raffiche diradate, non a ogni tasto).
//
// NON fa revalidatePath: ridisegnerebbe la home a ogni salvataggio — cioè
// rileggerebbe posta e Freshdesk mentre uno sta ancora scrivendo. Qui si salva
// e basta; il testo lo si rivede al prossimo caricamento della pagina.

export type EsitoBozza = { ok: true } | { ok: false; errore: string };

export async function salvaBozzaAction(chiave: string, testo: string): Promise<EsitoBozza> {
  // Le server action sono endpoint a sé: la sessione si ricontrolla qui.
  const op = await richiediOperatore();
  if (!chiave) return { ok: false, errore: "Recensione non indicata." };
  try {
    await salvaBozza(chiave, testo.slice(0, 5000), op._id);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "errore sconosciuto";
    console.warn("[bozza] salvataggio non riuscito:", msg);
    return { ok: false, errore: msg };
  }
}
