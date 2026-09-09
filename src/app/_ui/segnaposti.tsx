// Gli scheletri delle card: quello che si vede mentre i dati stanno arrivando.
//
// Vivono qui perché servono in DUE attese che devono somigliarsi: il
// `loading.tsx` della home (si aspetta la pagina intera, alla prima apertura) e
// il confine di attesa della lista «Da approvare» (si aspettano solo le card,
// cambiando tab o pagina). Se fossero due disegni diversi, la seconda attesa
// sembrerebbe l'inizio di un'altra pagina invece della stessa che si riempie.

export function CardSegnaposto() {
  return (
    <div className="skel-card" aria-hidden="true">
      <div className="skel-card-testa">
        <div className="skel skel-avatar" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="skel skel-riga" style={{ width: "38%" }} />
          <div className="skel skel-riga" style={{ width: "58%" }} />
        </div>
      </div>
      <div className="skel skel-riga" style={{ width: "96%" }} />
      <div className="skel skel-riga" style={{ width: "72%" }} />
      <div className="skel-azioni">
        <div className="skel skel-pill" />
        <div className="skel skel-tondo" />
        <div className="skel skel-tondo" />
        <div className="skel skel-tondo" />
        <div className="skel skel-tondo" />
      </div>
    </div>
  );
}

/**
 * La lista in attesa. `aria-live` perché il cambio non è provocato da un clic
 * su questo elemento: chi usa un lettore di schermo deve sentirsi dire che si
 * sta caricando, altrimenti il silenzio è indistinguibile da un blocco.
 */
export function ScheletroLista({ quante = 3 }: { quante?: number }) {
  return (
    <section className="dash-centro" aria-busy="true" aria-live="polite">
      <span className="sr-only">Carico le recensioni…</span>
      {Array.from({ length: quante }, (_, i) => (
        <CardSegnaposto key={i} />
      ))}
    </section>
  );
}
