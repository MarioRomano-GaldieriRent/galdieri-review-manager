import { resolveGoogleReviews } from "@/server/settings";

// Integrazione Google Business Profile (recensioni).
// Stato: SOLO CONFIGURAZIONE. Non effettua ancora chiamate reali.
//
// Perché non è già attiva: l'accesso alle API Business Profile non è
// automatico. Google assegna quota 0 di default e bisogna compilare il modulo
// di richiesta accesso; finché non viene approvata, ogni chiamata risponde 403.
// Nel frattempo le recensioni continuano ad arrivare via email (Zapier), che è
// la sorgente attualmente usata dal pannello Recensioni.
//
// Quando l'accesso sarà approvato serviranno:
//  - un client OAuth (client id + client secret) creato in Google Cloud Console
//  - un refresh token ottenuto una volta sola, con scope
//    https://www.googleapis.com/auth/business.manage
//  - l'id dell'account, nel formato accounts/1234567890
// Le letture avvengono poi su
//    https://mybusiness.googleapis.com/v4/{parent}/reviews

export type GoogleReviewsStatus = {
  configured: boolean;
  missing: string[];
  ready: boolean;
  note: string;
};

export async function getGoogleReviewsStatus(): Promise<GoogleReviewsStatus> {
  const cfg = await resolveGoogleReviews();

  const missing: string[] = [];
  if (!cfg.clientId) missing.push("Client ID");
  if (!cfg.clientSecret) missing.push("Client secret");
  if (!cfg.refreshToken) missing.push("Refresh token");
  if (!cfg.accountId) missing.push("Account ID");

  return {
    configured: missing.length === 0,
    missing,
    // Anche con i dati completi resta da ottenere l'approvazione della quota.
    ready: false,
    note:
      missing.length === 0
        ? "Dati completi. Manca l'approvazione della quota da parte di Google: finché non arriva, le chiamate rispondono 403."
        : "Compila i campi mancanti. Serve comunque la richiesta di accesso approvata da Google (quota 0 di default).",
  };
}
