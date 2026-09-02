"use client";

import { useFormStatus } from "react-dom";

// Il tasto "Entra" del login. Con useFormStatus sa quando il server sta
// verificando le credenziali: mostra "Accesso in corso…" con la rotellina e
// resta disabilitato, così non sembra fermo e non si clicca due volte.
export function BottoneEntra() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-primary login-invia"
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <span className="btn-caricamento">
          <span className="spinner-mini spinner-chiaro" aria-hidden="true" />
          Accesso in corso…
        </span>
      ) : (
        "Entra"
      )}
    </button>
  );
}
