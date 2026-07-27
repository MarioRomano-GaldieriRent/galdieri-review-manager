"use server";

import { redirect } from "next/navigation";
import { confermaTotp } from "@/server/auth/utenti";
import { completaLogin, sessionePendente } from "@/server/auth/sessione";

// Attivazione TOTP al primo accesso. La conferma NON reindirizza: torna i codici
// di recupero da mostrare una sola volta (via useActionState). Il passaggio
// finale — dopo che l'utente li ha salvati — promuove la sessione a completa.

export type StatoConferma =
  | { fase: "attesa" }
  | { fase: "errore"; messaggio: string }
  | { fase: "fatto"; codici: string[] };

export async function confermaAttivazioneAction(
  _prev: StatoConferma,
  formData: FormData,
): Promise<StatoConferma> {
  const pend = await sessionePendente();
  if (!pend) return { fase: "errore", messaggio: "Sessione scaduta: torna al login e riprova." };

  const codice = String(formData.get("codice") ?? "").trim();
  const r = await confermaTotp(pend.operatoreId, codice);
  if (!r.ok || !r.codiciRecupero) {
    return { fase: "errore", messaggio: "Codice non valido: usa quello che vedi ora nell'app." };
  }

  // Il secondo fattore è appena stato verificato QUI: solo ora la sessione
  // diventa "completa". È l'unico punto in cui si promuove passando per
  // l'attivazione, così la verifica non è aggirabile chiamando entraAction.
  await completaLogin(pend.operatoreId);
  return { fase: "fatto", codici: r.codiciRecupero };
}

/**
 * L'utente ha salvato i codici e clicca "Entra". La sessione è GIÀ completa
 * (promossa qui sopra dopo la verifica del codice): questa azione naviga
 * soltanto, non concede accessi.
 */
export async function entraAction(): Promise<void> {
  redirect("/");
}
