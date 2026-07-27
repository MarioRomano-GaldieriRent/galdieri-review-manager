"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  annullaPubblicazione,
  confermaOnline,
  leggiPubblicazione,
  segnaPubblicata,
  segnalaSparita,
} from "@/server/db/pubblicazioni";
import { chiudiFreshdeskPer, ritentaChiusura } from "@/server/pubblicazione";
import { richiediOperatore } from "@/server/auth/sessione";

// Azioni della coda "Da pubblicare". Ogni azione è attribuita all'operatore
// loggato: richiediOperatore() lo restituisce, o rimanda al login se manca (le
// server action sono endpoint a sé, quindi si proteggono qui, non solo nel gate).

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Torna al tab "Da pubblicare" della home conservando il filtro sede. */
function indietro(fd: FormData): never {
  const p = new URLSearchParams({ step: "pubblicare" });
  const sede = str(fd, "sede");
  if (sede) p.set("sede", sede);
  redirect(`/?${p}`);
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
  const op = await richiediOperatore();
  const chiave = str(formData, "chiave");
  if (chiave) {
    const ok = await segnaPubblicata(chiave, op._id, false);
    if (ok) {
      const voce = await leggiPubblicazione(chiave);
      if (voce) await chiudiFreshdeskPer(voce, op.nome);
    }
  }
  revalidatePath("/");
  indietro(formData);
}

/** Torna al tab "Da ricontrollare" della home. */
function indietroRicontrollo(): never {
  redirect("/?step=ricontrollo");
}

/** La risposta risulta online: il caso è chiuso. */
export async function confermaOnlineAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const chiave = str(formData, "chiave");
  if (chiave) await confermaOnline(chiave, op._id);
  revalidatePath("/");
  indietroRicontrollo();
}

/** La risposta è sparita da Google: torna in cima alla coda da pubblicare. */
export async function segnalaSparitaAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const chiave = str(formData, "chiave");
  if (chiave) await segnalaSparita(chiave, op._id);
  revalidatePath("/");
  indietroRicontrollo();
}

/** Errore umano: la pubblicazione non era avvenuta. Torna fra le da pubblicare. */
export async function annullaPubblicazioneAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const chiave = str(formData, "chiave");
  if (chiave) await annullaPubblicazione(chiave, op._id);
  revalidatePath("/");
  indietroRicontrollo();
}

/** Ritenta subito la chiusura del ticket rimasta in sospeso o fallita. */
export async function riprovaFreshdeskAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const chiave = str(formData, "chiave");
  if (chiave) await ritentaChiusura(chiave, op.nome);
  revalidatePath("/");
  indietroRicontrollo();
}
