"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

// I tab della home, con il RISCONTRO al clic.
//
// Perché serve un componente e non quattro <Link>: passare da un tab all'altro
// è la STESSA pagina con parametri diversi, quindi Next non fa scattare il
// loading.tsx — tiene a schermo la vista vecchia finché il server non risponde.
// E il server, sul tab «Da approvare», legge la posta e interroga Freshdesk:
// misurati 10-20 secondi in cui premevi e non succedeva NIENTE, né un
// cambiamento né un caricamento. Sembrava rotto, ed era solo lento e muto.
//
// Con useTransition sappiamo che la navigazione è in corso: il tab premuto
// mostra la rotellina al posto del conteggio e si spegne, così è chiaro che ha
// registrato il clic e sta lavorando.

export type VoceTab = {
  href: string;
  etichetta: string;
  titolo: string;
  attivo: boolean;
  /**
   * Il pallino col numero, già pronto — non il numero.
   *
   * Serve perché su «Da approvare» il conteggio esce dallo stesso lavoro lento
   * della lista: la pagina lo passa avvolto in un confine di attesa, così i tab
   * si vedono subito e il numero compare quando c'è. Qui dentro non si decide
   * più se mostrarlo: lo decide chi lo costruisce (vedi Pallino in page.tsx).
   */
  conteggio: ReactNode;
};

export function TabRecensioni({ voci }: { voci: VoceTab[] }) {
  const router = useRouter();
  const [inCorso, avvia] = useTransition();
  const [verso, setVerso] = useState<string | null>(null);

  return (
    <div className="pub-tabs-scroll">
      {voci.map((v) => {
        const suo = inCorso && verso === v.href;
        return (
          <Link
            key={v.href}
            href={v.href}
            title={v.titolo}
            aria-current={v.attivo ? "page" : undefined}
            aria-busy={suo}
            className={`pub-tab${v.attivo ? " is-active" : ""}${suo ? " is-in-corso" : ""}`}
            onClick={(e) => {
              // Il tab su cui si è già non deve fare nulla: senza questo
              // controllo mostrerebbe la rotellina per una navigazione che Next
              // scarta, e resterebbe a girare per sempre.
              if (v.attivo) {
                e.preventDefault();
                return;
              }
              e.preventDefault();
              setVerso(v.href);
              avvia(() => router.push(v.href));
            }}
          >
            {v.etichetta}
            {suo ? <span className="spinner-mini" aria-hidden="true" /> : v.conteggio}
          </Link>
        );
      })}
    </div>
  );
}
