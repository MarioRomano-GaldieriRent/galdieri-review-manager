"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Ricerca e filtro per stelle sulla lista «Da approvare».
//
// Come TastieraCoda, NON ridisegna la lista: nasconde le card già rese dal
// server, trovandole nel DOM. È una scelta, non una scorciatoia — filtrare
// dal server vorrebbe dire rifare a ogni tasto il giro lento della pagina
// (ingest della posta + sweep Freshdesk), che è proprio ciò che consuma il
// budget di chiamate al minuto di Freshdesk. Così la ricerca è istantanea e
// non costa una chiamata.
//
// Si cerca su NOME, SEDE e TESTO della recensione (anche nell'originale in
// lingua): i dati arrivano dagli attributi data-* delle card.
//
// PAGINAZIONE. La lista mostra una PAGINA di n recensioni alla volta (25 di
// default), quindi filtrare le card rese vuol dire filtrare SOLO quelle: cercare
// «Monica» quando Monica è in un'altra pagina darebbe «nessuna corrispondenza»,
// che è una risposta falsa. Perciò, quando la pagina dichiara di aver tagliato
// la lista (data-totale > card rese), lo si dice e si offre l'uscita in un
// clic: «Cerca fra tutte le N» → ?n=tutte&q=…, dove la ricerca riparte già
// scritta (e la paginazione, con tutto in una pagina sola, non serve più).

/** Parametri della vista che i link conservano: gli stessi di AutoAggiorna. */
const DA_CONSERVARE = ["step", "sede"] as const;

/** Minuscolo e senza accenti: «Lavallée» si deve trovare digitando «lavallee». */
function perConfronto(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function FiltriDaApprovare() {
  const box = useRef<HTMLDivElement>(null);
  const parametri = useSearchParams();
  // Si riparte dal `q` dell'indirizzo: è così che «Cerca fra tutte» ritrova la
  // ricerca dopo essere passato dal server. Mentre si digita `q` non si tocca —
  // scriverlo a ogni tasto vorrebbe dire navigare a ogni tasto.
  const [cerca, setCerca] = useState(() => parametri?.get("q") ?? "");
  const [stella, setStella] = useState<number | null>(null);
  const [visibili, setVisibili] = useState(0);
  const [totali, setTotali] = useState(0);
  /** Le stelle che compaiono davvero nella lista: gli altri tasti non servono. */
  const [disponibili, setDisponibili] = useState<number[]>([]);
  /**
   * Quante recensioni ci sono in tutto, se la lista è paginata: la pagina lo
   * dichiara con data-totale sul contenitore. Serve a NON mentire — filtrando
   * solo le card rese, senza questo numero un «nessuna corrispondenza» su una
   * lista tagliata alle prime 25 farebbe credere che la recensione non esista.
   * Facoltativo: se l'attributo non c'è, la lista è intera e non si avvisa.
   */
  const [totaleInLista, setTotaleInLista] = useState<number | null>(null);

  useEffect(() => {
    const contenitore = box.current?.closest(".dash-centro");
    if (!contenitore) return;

    const applica = () => {
      const cards = Array.from(contenitore.querySelectorAll<HTMLElement>(".dash-card"));
      const q = perConfronto(cerca);
      const viste = new Set<number>();
      let quante = 0;

      for (const c of cards) {
        const n = Number(c.dataset.stelle || "0");
        if (n) viste.add(n);
        const dove = perConfronto(
          `${c.dataset.nome ?? ""} ${c.dataset.sede ?? ""} ${c.dataset.testo ?? ""}`,
        );
        const mostra = (!q || dove.includes(q)) && (stella === null || n === stella);
        c.classList.toggle("is-filtrata", !mostra);
        if (mostra) quante++;
      }

      const ordinate = [...viste].sort((a, b) => b - a);
      const dichiarato = Number(contenitore.getAttribute("data-totale") || "0");
      setVisibili((p) => (p === quante ? p : quante));
      setTotali((p) => (p === cards.length ? p : cards.length));
      setDisponibili((p) => (p.join() === ordinate.join() ? p : ordinate));
      setTotaleInLista((p) => {
        const n = dichiarato > cards.length ? dichiarato : null;
        return p === n ? p : n;
      });
    };

    applica();

    // La lista si ridisegna da sola: auto-aggiornamento ogni 3 minuti e dopo
    // ogni azione sulle card. Senza osservatore, dopo un aggiornamento le card
    // nuove tornerebbero tutte visibili ignorando il filtro attivo.
    // Si osserva solo childList: le classi che mette `applica` sono attributi,
    // quindi non richiamano l'osservatore (niente rincorsa infinita).
    const osservatore = new MutationObserver(applica);
    osservatore.observe(contenitore, { childList: true, subtree: true });
    return () => osservatore.disconnect();
  }, [cerca, stella]);

  const attivo = cerca.trim() !== "" || stella !== null;

  const azzera = () => {
    setCerca("");
    setStella(null);
    // Via anche il `q` dall'indirizzo, altrimenti il prossimo «Aggiorna» (o un
    // ricarico) ripescherebbe la ricerca appena azzerata. Si cambia solo la
    // barra degli indirizzi, senza router: non c'è nulla da ricaricare, e un
    // giro dal server qui costerebbe posta e Freshdesk per niente.
    const u = new URL(window.location.href);
    if (u.searchParams.has("q")) {
      u.searchParams.delete("q");
      window.history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
    }
  };

  /** «Cerca fra tutte»: stessa vista, lista intera, ricerca già scritta. */
  const linkTutte = () => {
    const p = new URLSearchParams();
    for (const k of DA_CONSERVARE) {
      const v = parametri?.get(k);
      if (v) p.set(k, v);
    }
    // I parametri volatili (fresh, run, esito…) NON si portano dietro: fresh
    // rifarebbe l'ingest per niente e run/esito rimetterebbero banner vecchi.
    p.set("n", "tutte");
    const q = cerca.trim();
    if (q) p.set("q", q);
    return `/?${p.toString()}`;
  };

  return (
    <div className="appr-filtri" ref={box}>
      <div className="appr-filtri-riga">
        <input
          type="search"
          className="appr-cerca"
          value={cerca}
          onChange={(e) => setCerca(e.target.value)}
          placeholder="Cerca per nome, sede o testo della recensione…"
          aria-label="Cerca fra le recensioni da approvare"
        />
        {/* I tasti ci sono anche quando la lista ha una sola valutazione (a
            occhio spento sono tutte 5★): un controllo che appare e sparisce da
            solo si fa fatica a ritrovarlo. */}
        {disponibili.length > 0 && (
          <select
            className="appr-stelle"
            value={stella === null ? "" : String(stella)}
            onChange={(e) => setStella(e.target.value === "" ? null : Number(e.target.value))}
            aria-label="Filtra per stelle"
          >
            <option value="">Tutte le stelle</option>
            {disponibili.map((n) => (
              <option key={n} value={n} aria-label={n === 1 ? "1 stella" : `${n} stelle`}>
                {/* ⭐ è un'emoji a colori (giallo fisso, non lo tocca il CSS);
                    ★ è il glifo monocromo, intonato scuro dal CSS qui sotto —
                    così le vuote si vedono, ma senza un contorno acceso. */}
                {"⭐".repeat(n)}
                {"★".repeat(5 - n)}
              </option>
            ))}
          </select>
        )}
        {attivo && (
          <button type="button" className="btn-mini" onClick={azzera}>
            Azzera
          </button>
        )}
      </div>

      {attivo && (
        <div className="appr-conteggio">
          {/* Con la lista tagliata si dice SEMPRE fra quante si sta cercando:
              un «nessuna corrispondenza» calcolato sulle prime 25 farebbe
              credere che una recensione più in fondo non esista. */}
          <p className="hint" aria-live="polite">
            {totaleInLista === null
              ? visibili === 0
                ? "Nessuna recensione corrisponde ai filtri."
                : `${visibili} di ${totali} recensioni`
              : visibili === 0
                ? `Nessuna corrispondenza fra le ${totali} mostrate — in lista ce ne sono ${totaleInLista}.`
                : `${visibili} di ${totali} mostrate — in lista ce ne sono ${totaleInLista}.`}
          </p>
          {/* Niente pulsante se si è GIÀ su «tutte»: la lista può restare
              tagliata dal tetto della paginazione, e un tasto che riporta dove
              si è già è peggio che non averlo. Il testo dice comunque il vero. */}
          {totaleInLista !== null && parametri?.get("n") !== "tutte" && (
            <Link href={linkTutte()} className="btn-mini">
              Cerca fra tutte le {totaleInLista} →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
