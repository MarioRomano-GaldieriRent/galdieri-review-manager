"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { richiediAdmin, richiediOperatore } from "@/server/auth/sessione";
import { leggiRecensione } from "@/server/db/recensioni";
import { chiudiSegnalazione, segnala } from "@/server/db/segnalazioni";

// Le azioni della segnalazione. La guardia sta QUI, dentro ogni azione: il
// middleware non valida la sessione. Segnalare lo fa chiunque sia loggato;
// risolvere e rimettere in coda solo l'admin.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** L'operatore passa all'amministratore una recensione che non riesce a gestire. */
export async function segnalaAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const chiave = str(formData, "chiave");
  const nota = str(formData, "nota").slice(0, 1000);
  if (!chiave || !nota) redirect("/?errore=segnalazione-senza-nota");
  const r = await leggiRecensione(chiave);
  if (!r) redirect("/?errore=recensione-non-trovata");
  await segnala(r, nota, op._id);
  revalidatePath("/");
  revalidatePath("/supervisione");
  const msg = `Segnalazione inviata: «${r.nome || "la recensione"}» è passata all'amministratore.`;
  redirect(`/?esitoOk=1&esitoMsg=${encodeURIComponent(msg)}`);
}

/** L'admin ha sistemato: la recensione resta fuori dalla coda dell'operatore. */
export async function risolviSegnalazioneAction(formData: FormData): Promise<void> {
  const admin = await richiediAdmin();
  const chiave = str(formData, "chiave");
  if (chiave) await chiudiSegnalazione(chiave, "risolta", str(formData, "nota").slice(0, 1000), admin._id);
  revalidatePath("/supervisione");
  revalidatePath("/");
  redirect("/supervisione");
}

/** L'admin la rimanda all'operatore: ricompare in «Da approvare». */
export async function rimettiInCodaSegnalazioneAction(formData: FormData): Promise<void> {
  const admin = await richiediAdmin();
  const chiave = str(formData, "chiave");
  if (chiave) await chiudiSegnalazione(chiave, "rimessa", str(formData, "nota").slice(0, 1000), admin._id);
  revalidatePath("/supervisione");
  revalidatePath("/");
  redirect("/supervisione");
}
