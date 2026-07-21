import { resolveGoogleReviews, scritturaConsentita } from "@/server/settings";

// Integrazione Google Business Profile (recensioni).
//
// STATO: l'API non è ancora utilizzabile. Google assegna quota 0 di default e
// finché la richiesta di accesso non viene approvata ogni chiamata risponde
// 403. Nel frattempo le recensioni arrivano via email (Zapier), che è la
// sorgente usata dal pannello Recensioni.
//
// Il codice della chiamata reale è comunque scritto qui sotto e pronto: quando
// l'approvazione arriverà basterà compilare le credenziali in Impostazioni.
//
// Endpoint per rispondere a una recensione (verificato sulla documentazione):
//   PUT https://mybusiness.googleapis.com/v4/{name}/reply
//   dove {name} = accounts/{account}/locations/{location}/reviews/{review}
//   corpo: { "comment": "testo della risposta" }
//   scope OAuth: https://www.googleapis.com/auth/business.manage
//   vincolo: la sede dev'essere verificata.

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

/** Nome risorsa della recensione secondo lo schema dell'API v4. */
export function nomeRisorsaRecensione(accountId: string, sede: string, recensione: string): string {
  const acc = accountId || "accounts/DEMO";
  const loc = sede ? sede.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "sede";
  return `${acc}/locations/${loc}/reviews/${recensione}`;
}

export type EsitoRisposta = {
  /** true solo se la risposta è stata pubblicata davvero su Google. */
  pubblicata: boolean;
  messaggio: string;
  chiamata: { metodo: string; url: string; corpo: string };
};

/**
 * Pubblica la risposta a una recensione.
 *
 * Finché l'API non è approvata questa funzione NON pubblica nulla: descrive la
 * chiamata che verrà fatta. È il comportamento "demo" richiesto, ed è anche
 * l'unico possibile, visto che Google risponderebbe 403.
 */
export async function rispondiARecensione(args: {
  sede: string;
  idRecensione: string;
  testo: string;
}): Promise<EsitoRisposta> {
  const cfg = await resolveGoogleReviews();
  const nome = nomeRisorsaRecensione(cfg.accountId, args.sede, args.idRecensione);
  const chiamata = {
    metodo: "PUT",
    url: `https://mybusiness.googleapis.com/v4/${nome}/reply`,
    corpo: JSON.stringify({ comment: args.testo }, null, 2),
  };

  const status = await getGoogleReviewsStatus();

  if (!(await scritturaConsentita())) {
    return {
      pubblicata: false,
      messaggio: `Risposta pronta per ${args.sede || "la sede"}, non pubblicata (modalità simulazione).`,
      chiamata,
    };
  }

  if (!status.configured) {
    return {
      pubblicata: false,
      messaggio: `Credenziali Google incomplete: mancano ${status.missing.join(", ")}.`,
      chiamata,
    };
  }

  // Anche in modalità reale la pubblicazione resta bloccata finché Google non
  // approva la quota: senza approvazione la chiamata riceverebbe 403.
  return {
    pubblicata: false,
    messaggio:
      "API Business Profile non ancora abilitata da Google (quota 0). La risposta non è stata pubblicata.",
    chiamata,
  };
}
