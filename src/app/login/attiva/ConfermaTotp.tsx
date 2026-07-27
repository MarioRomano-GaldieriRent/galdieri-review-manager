"use client";

import { useActionState } from "react";
import { confermaAttivazioneAction, entraAction, type StatoConferma } from "./actions";

// Conferma dell'attivazione TOTP. Usa useActionState così i codici di recupero
// tornano dall'azione e si mostrano UNA sola volta, senza salvarli in chiaro da
// nessuna parte. Dopo che l'utente li ha salvati, "Entra" promuove la sessione.

const INIZIALE: StatoConferma = { fase: "attesa" };

export function ConfermaTotp() {
  const [stato, azione, inCorso] = useActionState(confermaAttivazioneAction, INIZIALE);

  if (stato.fase === "fatto") {
    return (
      <div className="totp-fatto">
        <h2 className="login-titolo">Salva i codici di recupero</h2>
        <p className="hint">
          Servono per entrare se perdi il telefono. Ognuno vale una volta sola. Conservali in un
          posto sicuro: <strong>non li rivedrai più</strong>.
        </p>
        <ul className="totp-codici">
          {stato.codici.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <form action={entraAction}>
          <button type="submit" className="btn-primary login-invia">
            Ho salvato i codici — Entra
          </button>
        </form>
      </div>
    );
  }

  return (
    <form action={azione} className="login-form">
      {stato.fase === "errore" && <p className="form-error login-errore">{stato.messaggio}</p>}
      <label className="login-campo">
        <span>Codice dall&apos;app</span>
        <input
          name="codice"
          autoFocus
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          className="login-codice"
        />
      </label>
      <button type="submit" className="btn-primary login-invia" disabled={inCorso}>
        {inCorso ? "Verifico…" : "Attiva e continua"}
      </button>
    </form>
  );
}
