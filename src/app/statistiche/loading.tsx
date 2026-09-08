// Placeholder istantaneo di /statistiche, sullo stesso principio di
// src/app/loading.tsx: la pagina vera fa sette letture Mongo in parallelo —
// veloci singolarmente, ma non istantanee — questo compare mentre le aspetta.

export default function CaricamentoStatistiche() {
  return (
    <main className="dash" aria-busy="true" aria-live="polite">
      <span className="sr-only">Carico le statistiche…</span>
      <div className="skel skel-titolo" />
      <section className="card">
        <div className="stat-griglia" aria-hidden="true">
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
        </div>
      </section>
      <section className="card">
        <div className="stat-griglia" aria-hidden="true">
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
          <div className="skel skel-tile" />
        </div>
      </section>
    </main>
  );
}
