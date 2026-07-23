"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { leggiPubblicazione, segnaPubblicata } from "@/server/db/pubblicazioni";
import { chiudiFreshdeskPer } from "@/server/pubblicazione";
import { OPERATORE_SISTEMA } from "@/server/db/attivita";

// Azioni della coda "Da pubblicare". L'operatore è sempre Sistema finché non
// c'è un login (vedi attivita.ts).

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Torna alla coda conservando i filtri da cui si era partiti. */
function indietro(fd: FormData): never {
  const p = new URLSearchParams();
  const sede = str(fd, "sede");
  const stelle = str(fd, "stelle");
  if (sede) p.set("sede", sede);
  if (stelle) p.set("stelle", stelle);
  const s = p.toString();
  redirect(s ? `/da-pubblicare?${s}` : "/da-pubblicare");
}

/**
 * Segna la risposta come pubblicata su Google (l'operatore l'ha appena
 * incollata a mano) e chiude il ticket collegato.
 *
 * Due cose distinte: il passaggio di stato è interno e avviene sempre; la
 * chiusura del ticket è una scrittura esterna e parte solo in modalità reale
 * (lo decide chiudiFreshdeskPer). Un errore Freshdesk non blocca: la voce
 * resta pubblicata e la chiusura entra nella coda di retry.
 */
export async function segnaPubblicataAction(formData: FormData): Promise<void> {
  const chiave = str(formData, "chiave");
  if (chiave) {
    const ok = await segnaPubblicata(chiave, OPERATORE_SISTEMA, false);
    if (ok) {
      const voce = await leggiPubblicazione(chiave);
      if (voce) await chiudiFreshdeskPer(voce, "Sistema");
    }
  }
  revalidatePath("/da-pubblicare");
  indietro(formData);
}
