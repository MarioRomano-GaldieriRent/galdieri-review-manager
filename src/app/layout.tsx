import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import "./globals.css";
import { ThemeToggle } from "./ThemeToggle";
import { operatoreCorrente } from "@/server/auth/sessione";
import { logoutAction } from "./login/actions";

export const metadata: Metadata = {
  title: "GaldieriReviews",
  description:
    "Gestione delle recensioni Google e Trustpilot: coda di pubblicazione, automazioni e posta monitorata.",
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

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // x-pathname arriva dal middleware. La pagina di login (e le sue sotto-pagine)
  // non hanno testata e non passano dal controllo di sessione.
  const pathname = (await headers()).get("x-pathname") ?? "";
  const suLogin = pathname === "/login" || pathname.startsWith("/login/");

  // Gate vero: fuori dal login serve un operatore loggato. Un cookie scaduto o
  // fasullo (che il middleware lascia passare) viene fermato qui.
  const operatore = suLogin ? null : await operatoreCorrente();
  if (!suLogin && !operatore) redirect("/login");

  return (
    <html lang="it" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {operatore && (
          <header className="app-header">
            <div className="app-header-inner">
              <Link href="/" className="brand" aria-label="GaldieriReviews — vai alla home">
                <span className="logo">
                  <span className="logo-name">Galdieri</span>
                  <span className="logo-rent">Reviews</span>
                </span>
              </Link>
              <nav className="app-nav">
                <Link href="/">Pubblicazione</Link>
                <Link href="/automazioni">Automazioni</Link>
                <Link href="/impostazioni">Impostazioni</Link>
              </nav>
              <div className="app-header-destra">
                <span
                  className="utente-corrente"
                  title={operatore.ruolo === "admin" ? "Amministratore" : "Operatore"}
                >
                  {operatore.nome}
                </span>
                <form action={logoutAction}>
                  <button type="submit" className="btn-mini">
                    Esci
                  </button>
                </form>
                <ThemeToggle />
              </div>
            </div>
          </header>
        )}
        {children}
      </body>
    </html>
  );
}
