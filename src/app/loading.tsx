// Placeholder istantaneo della home. La pagina vera (page.tsx) aspetta la
// posta (Microsoft Graph) e Freshdesk — qualche secondo, a volte di più in
// dev — prima di avere qualcosa da mostrare. Next manda QUESTO file appena la
// richiesta parte (Suspense automatico per cartella), così lo schermo non
// resta bianco/fermo nel frattempo: appena page.tsx è pronta lo scambio è
// automatico, senza ricaricare né codice lato client.
//
// L'header (logo, Statistiche/Supervisione, ingranaggio) sta in layout.tsx,
// FUORI da questo Suspense: resta a schermo per tutta l'attesa, non sparisce.

function CardSegnaposto() {
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

export default function CaricamentoHome() {
  return (
    <main className="pipeline" aria-busy="true" aria-live="polite">
      <span className="sr-only">Carico le recensioni…</span>
      <nav className="skel-tabs" aria-hidden="true">
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
      </nav>
      <section className="dash-centro">
        <CardSegnaposto />
        <CardSegnaposto />
        <CardSegnaposto />
      </section>
    </main>
  );
}
