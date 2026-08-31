"use client";

import { useRef, useState } from "react";
import { cercaSuGoogleAction } from "./dashboard/actions";
import type { EsitoRobot } from "@/server/robot/lancia";

// Tasto "G" della card. Al click lancia il robot che cerca la recensione su
// Google e, mentre cerca, mostra un caricamento ("sto cercando…"); appena il
// robot risponde mostra l'esito (trovata / non trovata / Chrome aperto…). La
// finestra del robot resta aperta per conto suo: qui si vede solo com'è andata.

/** Il logo "G" di Google a 4 colori. */
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** L'icona dell'esito: trovata, cercata-ma-non-trovata, oppure problema. */
function iconaEsito(e: EsitoRobot): string {
  if (e.trovata) return "✅";
  if (e.stato === "aperta-non-trovata") return "🔍";
  return "⚠️";
}

export function BottoneGoogle({
  chiave,
  label,
  nome,
}: {
  chiave: string;
  label: string;
  nome: string;
}) {
  const [cercando, setCercando] = useState(false);
  const [esito, setEsito] = useState<EsitoRobot | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  async function cerca() {
    if (cercando) return;
    setEsito(null);
    setCercando(true);
    // Il testo attuale del riquadro (eventualmente modificato dall'operatore):
    // il bottone sta dentro il form della card, così lo si legge da lì.
    const campo = ref.current?.form?.elements.namedItem("testo");
    const testo = campo instanceof HTMLTextAreaElement ? campo.value : "";
    try {
      setEsito(await cercaSuGoogleAction(chiave, label, testo));
    } catch {
      setEsito({
        ok: false,
        stato: "errore",
        messaggio: "Qualcosa è andato storto nell'avvio del robot. Riprova.",
      });
    } finally {
      setCercando(false);
    }
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="btn-google"
        onClick={cerca}
        disabled={cercando}
        aria-busy={cercando}
        title="Cerca la recensione su Google col robot: mostra se la trova e lascia la finestra aperta. Serve Chrome chiuso."
        aria-label="Cerca su Google col robot"
      >
        {cercando ? <span className="spinner-mini" aria-hidden="true" /> : <GoogleG />}
      </button>

      {(cercando || esito) && (
        <span
          className={`google-esito ${cercando ? "attesa" : esito!.ok ? "ok" : "ko"}`}
          role="status"
          aria-live="polite"
        >
          {cercando
            ? `🔎 Cerco «${nome || "la recensione"}» su Google…`
            : `${iconaEsito(esito!)} ${esito!.messaggio}`}
        </span>
      )}
    </>
  );
}
