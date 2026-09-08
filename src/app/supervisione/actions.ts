"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { richiediAdmin, richiediOperatore } from "@/server/auth/sessione";
import { leggiRecensione } from "@/server/db/recensioni";
import { chiudiSegnalazione, segnala } from "@/server/db/segnalazioni";
import { avvisaAdminDiSegnalazione } from "@/server/notifiche/segnalazione";

// Le azioni della segnalazione. La guardia sta QUI, dentro ogni azione: il
// middleware non valida la sessione. Segnalare lo fa chiunque sia loggato;
// risolvere e rimettere in coda solo l'admin.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/**
 * L'indirizzo con cui raggiungere il gestionale, per il tasto dentro la mail.
 *
 * Si ricava dall'indirizzo che sta usando in questo momento chi segnala (header
 * Host): se Stefania lavora su http://IP:4000, il link punta lì e funziona per
 * chiunque sia nella stessa rete. `APP_URL` nel .env ha la precedenza, per
 * quando ci sarà un nome vero o l'HTTPS.
 */
async function indirizzoApp(): Promise<string> {
  const forzato = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (forzato) return forzato;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:4000";
  const protocollo = h.get("x-forwarded-proto") ?? "http";
  return `${protocollo}://${host}`;
}

/** L'operatore passa all'amministratore una recensione che non riesce a gestire. */
export async function segnalaAction(formData: FormData): Promise<void> {
  const op = await richiediOperatore();
  const chiave = str(formData, "chiave");
  const nota = str(formData, "nota").slice(0, 1000);
  if (!chiave || !nota) redirect("/?errore=segnalazione-senza-nota");
  const r = await leggiRecensione(chiave);
  if (!r) redirect("/?errore=recensione-non-trovata");
  await segnala(r, nota, op._id);

  // Avviso agli admin. Best-effort DOPO il salvataggio: se la posta non parte
  // la segnalazione resta comunque nel pannello, e il motivo finisce nei log.
  const avviso = await avvisaAdminDiSegnalazione({
    recensione: r,
    nota,
    daChi: op.nome || op.chiave,
    link: `${await indirizzoApp()}/supervisione`,
  });
  console.log(
    avviso.inviata
      ? `[segnalazione] avviso inviato a ${avviso.motivo}`
      : `[segnalazione] avviso NON inviato: ${avviso.motivo}`,
  );

  revalidatePath("/");
  revalidatePath("/supervisione");
  const msg = avviso.inviata
    ? `Segnalazione inviata: «${r.nome || "la recensione"}» è passata all'amministratore, che ha ricevuto la mail.`
    : `Segnalazione registrata: «${r.nome || "la recensione"}» è passata all'amministratore (avviso per email non partito).`;
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
