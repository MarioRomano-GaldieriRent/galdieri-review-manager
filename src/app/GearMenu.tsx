"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";
import { logoutAction } from "./login/actions";

// Unico menu dell'app: un ingranaggio in alto a destra. Raccoglie le voci
// riservate (Impostazioni, Automazioni…) — che il layout passa già filtrate per
// ruolo — più il tema e l'uscita. La top bar non ha altri menu: la home è la
// pagina di lavoro, tutto il resto sta qui dentro.

type Voce = { href: string; label: string };

export function GearMenu({
  nome,
  ruolo,
  voci,
}: {
  nome: string;
  ruolo: string;
  voci: Voce[];
}) {
  const [aperto, setAperto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aperto) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAperto(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAperto(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [aperto]);

  return (
    <div className="gear" ref={ref}>
      <button
        type="button"
        className="gear-btn"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={aperto}
        onClick={() => setAperto((v) => !v)}
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {aperto && (
        <div className="gear-menu" role="menu">
          <div className="gear-utente">
            <strong>{nome}</strong>
            <span className="muted">{ruolo === "admin" ? "Amministratore" : "Operatore"}</span>
          </div>

          {voci.length > 0 && (
            <div className="gear-sezione">
              {voci.map((v) => (
                <Link
                  key={v.href}
                  href={v.href}
                  className="gear-voce"
                  role="menuitem"
                  onClick={() => setAperto(false)}
                >
                  {v.label}
                </Link>
              ))}
            </div>
          )}

          <div className="gear-sezione gear-riga">
            <span>Tema scuro</span>
            <ThemeToggle />
          </div>

          <form action={logoutAction} className="gear-sezione">
            <button type="submit" className="gear-voce gear-esci" role="menuitem">
              Esci
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
