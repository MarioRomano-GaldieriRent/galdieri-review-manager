"use client";

import { useFormStatus } from "react-dom";

// Il tasto "Rispondi" della card. Sta dentro il <form action={playAction}>, e
// grazie a useFormStatus sa quando il flusso è in corso: mentre il robot lavora
// sul server (pubblica su Google, poi email + ticket) mostra un caricamento —
// "Sto rispondendo…" con la rotellina — e resta disabilitato, così si capisce
// che sta lavorando e non si clicca due volte. Torna normale quando arriva
// l'esito (che compare nel banner in alto).

export function BottoneRispondi() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn-rispondi"
      disabled={pending}
      aria-busy={pending}
      title="Risponde alla recensione: pubblica su Google (col robot), invia l'email e aggiorna il ticket."
    >
      {pending ? (
        <span className="btn-caricamento">
          <span className="spinner-mini spinner-chiaro" aria-hidden="true" />
          Sto rispondendo…
        </span>
      ) : (
        "Rispondi"
      )}
    </button>
  );
}
