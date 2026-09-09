"use client";

import { useState, type ReactNode } from "react";

// Il menu laterale delle Impostazioni e i suoi pannelli.
//
// Perché sta nel browser. Prima ogni voce era un link: cambiare sezione voleva
// dire un giro completo sul server — sessione, impostazioni, regole, sedi — per
// riscrivere una pagina in cui cambia solo la colonna di destra. Fra il clic e
// il cambio non si muoveva niente, e su un server carico erano secondi di
// schermo fermo. Un pannello di configurazione non ha nessun motivo di chiedere
// al server quale delle sue schede guardare.
//
// Ora i pannelli arrivano tutti insieme, già scritti dal server, e qui si
// accende quello scelto: il cambio è istantaneo e non tocca la rete. Il prezzo
// è una pagina più pesante da caricare UNA volta — la sezione «Regole» da sola
// è la metà del peso — in cambio di zero attesa su ogni clic successivo.
//
// L'indirizzo resta quello giusto (?s=…) con replaceState, così un link
// copiato apre la stessa sezione, ma senza far ricaricare niente. Le voci
// restano <a> con un href vero: si aprono in una scheda nuova col tasto
// centrale o con ctrl-clic, come ci si aspetta da un link.

export type VoceSezione = {
  id: string;
  voce: string;
  gruppo: string;
  /** La pastiglia a destra del nome: «REALE», «3/5», «ok»… */
  stato: string;
  /** Vero quando quello stato va guardato: la pastiglia diventa rossa. */
  preoccupa: boolean;
};

export type PannelloSezione = { id: string; nodo: ReactNode };

/** L'indirizzo di una sezione. «modo» è quella di partenza: nessun parametro. */
function indirizzo(id: string): string {
  return id === "modo" ? "/impostazioni" : `/impostazioni?s=${id}`;
}

export function Sezioni({
  iniziale,
  voci,
  altrePagine,
  pannelli,
}: {
  iniziale: string;
  voci: VoceSezione[];
  /** Le voci che portano fuori dal pannello: restano link veri. */
  altrePagine: ReactNode;
  pannelli: PannelloSezione[];
}) {
  const [scelta, setScelta] = useState(iniziale);
  const gruppi = [...new Set(voci.map((v) => v.gruppo))];

  return (
    <>
      <nav className="pannello-menu" aria-label="Sezioni delle impostazioni">
        {gruppi.map((g) => (
          <div key={g} className="menu-gruppo">
            <p className="menu-gruppo-titolo">{g}</p>
            {voci
              .filter((v) => v.gruppo === g)
              .map((v) => (
                <a
                  key={v.id}
                  href={indirizzo(v.id)}
                  className={`menu-voce${v.id === scelta ? " is-active" : ""}`}
                  aria-current={v.id === scelta ? "page" : undefined}
                  onClick={(e) => {
                    // Ctrl/cmd/shift-clic e tasto centrale devono continuare a
                    // fare quello che fanno sempre: aprire altrove.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    setScelta(v.id);
                    window.history.replaceState(null, "", indirizzo(v.id));
                  }}
                >
                  <span className="menu-voce-testo">{v.voce}</span>
                  <span className={`menu-voce-stato${v.preoccupa ? " ko" : ""}`}>{v.stato}</span>
                </a>
              ))}
          </div>
        ))}
        {altrePagine}
      </nav>

      <div className="pannello-contenuto">
        {pannelli.map((p) => (
          // `hidden` e non un montaggio condizionale: quello che si scrive in un
          // campo non deve sparire passando a un'altra sezione e tornando.
          <div key={p.id} className="sezione-pannello" hidden={p.id !== scelta}>
            {p.nodo}
          </div>
        ))}
      </div>
    </>
  );
}
