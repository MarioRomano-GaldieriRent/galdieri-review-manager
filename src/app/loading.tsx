import { ScheletroLista } from "./_ui/segnaposti";

// Placeholder istantaneo della home, per la PRIMA apertura. Next lo manda
// appena la richiesta parte (Suspense automatico per cartella), così lo schermo
// non resta bianco/fermo: appena la pagina è pronta lo scambio è automatico.
//
// Da qui in poi dura poco: la pagina ora si costruisce a pezzi, e la sua parte
// veloce — tab e intestazione — arriva subito. Le card hanno un loro confine di
// attesa dentro page.tsx, con gli STESSI scheletri (vedi _ui/segnaposti).
//
// L'header (logo, Statistiche/Supervisione, ingranaggio) sta in layout.tsx,
// FUORI da questo Suspense: resta a schermo per tutta l'attesa, non sparisce.

export default function CaricamentoHome() {
  return (
    <main className="pipeline" aria-busy="true" aria-live="polite">
      <nav className="skel-tabs" aria-hidden="true">
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
        <div className="skel skel-tab" />
      </nav>
      <ScheletroLista />
    </main>
  );
}
