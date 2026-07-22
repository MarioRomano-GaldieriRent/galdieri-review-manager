import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { GlassFilters } from "./GlassFilters";
import { ThemeToggle } from "./ThemeToggle";

export const metadata: Metadata = {
  title: "Posta in arrivo — Galdieri rent",
  description:
    "Email in arrivo sulla casella monitorata, incluse le notifiche di nuove recensioni Google e Trustpilot.",
};

// Applica il tema salvato PRIMA del primo paint, così non si vede il lampo bianco.
const themeScript = `
(function(){try{
  var t = localStorage.getItem('theme');
  document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
}catch(e){
  document.documentElement.setAttribute('data-theme','light');
}})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <GlassFilters />
        {/* Ambiente dietro al vetro: senza qualcosa da rifrangere, il vetro
            non esiste. Sono due livelli, non uno sfondo piatto. */}
        <div className="ambiente" aria-hidden="true" />
        <div className="ambiente-grana" aria-hidden="true" />
        <header className="app-header">
          <div className="app-header-inner">
            <div className="brand">
              <span className="logo">
                <span className="logo-name">Galdieri</span>
                <span className="logo-rent">rent</span>
              </span>
            </div>
            <nav className="app-nav">
              <Link href="/recensioni">Recensioni</Link>
              <Link href="/automazioni">Automazioni</Link>
              <Link href="/">Posta</Link>
              <Link href="/ticket">Ticket</Link>
              <Link href="/impostazioni">Impostazioni</Link>
            </nav>
            <ThemeToggle />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
