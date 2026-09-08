// Placeholder istantaneo di /supervisione, sullo stesso principio di
// src/app/loading.tsx: mostrato subito da Next mentre la pagina vera aggrega
// i numeri del periodo, poi sostituito da sola quando è pronta.

export default function CaricamentoSupervisione() {
  return (
    <main className="dash" aria-busy="true" aria-live="polite">
      <span className="sr-only">Carico la supervisione…</span>
      <div className="skel skel-titolo" />
      <nav className="skel-tabs" aria-hidden="true">
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
      </nav>
      <section className="card">
        <div className="stat-griglia" aria-hidden="true">
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
        </div>
      </section>
    </main>
  );
}
