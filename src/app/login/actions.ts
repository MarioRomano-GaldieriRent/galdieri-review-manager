"use server";

import { redirect } from "next/navigation";
import { verificaAccesso } from "@/server/auth/utenti";
import { creaSessione, distruggiSessione } from "@/server/auth/sessione";
import { registraAttivita } from "@/server/db/attivita";

// Azioni del login. Accesso a UN SOLO fattore: username + password. Nessun TOTP.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Accesso: username + password. */
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

  await creaSessione(esito.operatoreId);
  await registraAttivita("accesso.ok", {
    operatoreId: esito.operatoreId,
    oggettoTipo: "operatore",
    oggettoId: String(esito.operatoreId),
  });
  redirect("/");
}

/** Logout, disponibile ovunque tramite il pulsante in testata. */
export async function logoutAction(): Promise<void> {
  await distruggiSessione();
  redirect("/login");
}
