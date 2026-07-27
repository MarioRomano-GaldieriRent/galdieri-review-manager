"use server";

import { redirect } from "next/navigation";
import { verificaAccesso, verificaSecondoFattore } from "@/server/auth/utenti";
import {
  completaLogin,
  creaSessione,
  distruggiSessione,
  sessionePendente,
} from "@/server/auth/sessione";
import { registraAttivita } from "@/server/db/attivita";

// Azioni del login. Il primo fattore (password) apre una sessione "attesa_totp";
// il secondo fattore la promuove a "completa". Nessuna delle due scrive niente
// di operativo: cambiano solo lo stato dell'autenticazione.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Primo fattore: username + password. */
export async function accediAction(formData: FormData): Promise<void> {
  const chiave = str(formData, "chiave");
  const password = String(formData.get("password") ?? "");

  const esito = await verificaAccesso(chiave, password);
  if (!esito.ok) {
    if (esito.motivo === "bloccato") {
      redirect(`/login?e=bloccato&m=${esito.minutiBlocco ?? 15}`);
    }
    redirect(`/login?e=${esito.motivo}`);
  }

  await creaSessione(esito.operatoreId, "attesa_totp");
  await registraAttivita("accesso.password_ok", {
    operatoreId: esito.operatoreId,
    oggettoTipo: "operatore",
    oggettoId: String(esito.operatoreId),
  });

  // TOTP già attivo → passo al codice. Altrimenti → attivazione (primo accesso).
  redirect(esito.totpAttivo ? "/login?fase=codice" : "/login/attiva");
}

/** Secondo fattore: codice TOTP o codice di recupero. */
export async function verificaCodiceAction(formData: FormData): Promise<void> {
  const pend = await sessionePendente();
  if (!pend) redirect("/login?e=scaduta");

  const codice = str(formData, "codice");
  const r = await verificaSecondoFattore(pend.operatoreId, codice);
  if (!r.ok) {
    if (r.bloccato) {
      // Troppi codici errati: si chiude la sessione d'attesa e si riparte dal
      // primo fattore, a sua volta bloccato per 15 minuti.
      await distruggiSessione();
      redirect("/login?e=bloccato&m=15");
    }
    redirect("/login?fase=codice&e=codice");
  }

  await completaLogin(pend.operatoreId);
  await registraAttivita(r.recupero ? "accesso.recupero_ok" : "accesso.totp_ok", {
    operatoreId: pend.operatoreId,
    oggettoTipo: "operatore",
    oggettoId: String(pend.operatoreId),
  });
  redirect("/");
}

/** Logout, disponibile ovunque tramite il pulsante in testata. */
export async function logoutAction(): Promise<void> {
  await distruggiSessione();
  redirect("/login");
}
