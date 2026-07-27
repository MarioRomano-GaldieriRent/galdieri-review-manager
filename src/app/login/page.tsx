import { totpAttivo } from "@/server/auth/utenti";
import { operatoreCorrente, sessionePendente } from "@/server/auth/sessione";
import { redirect } from "next/navigation";
import { accediAction, verificaCodiceAction, logoutAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accesso — GaldieriReviews" };

const MESSAGGI: Record<string, string> = {
  credenziali: "Username o password non corretti.",
  disattivato: "Questo utente è disattivato: chiedi a un amministratore.",
  scaduta: "Sessione scaduta: rientra con username e password.",
  codice: "Codice non valido. Riprova con quello che vedi ora nell'app.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; m?: string }>;
}) {
  const sp = await searchParams;

  // Già dentro? Alla home.
  if (await operatoreCorrente()) redirect("/");

  // Fase del login: derivata dallo stato reale della sessione, non dall'URL.
  const pend = await sessionePendente();
  let fase: "password" | "codice" = "password";
  if (pend) {
    if (await totpAttivo(pend.operatoreId)) fase = "codice";
    else redirect("/login/attiva");
  }

  const errore =
    sp.e === "bloccato"
      ? `Troppi tentativi falliti. Riprova fra ${sp.m ?? 15} minuti.`
      : sp.e
        ? (MESSAGGI[sp.e] ?? "Accesso non riuscito.")
        : null;

  return (
    <main className="login-schermo">
      <section className="login-box card">
        <div className="login-logo">
          <span className="logo">
            <span className="logo-name">Galdieri</span>
            <span className="logo-rent">Reviews</span>
          </span>
        </div>

        {errore && <p className="form-error login-errore">{errore}</p>}

        {fase === "password" ? (
          <form action={accediAction} className="login-form">
            <h1 className="login-titolo">Accesso</h1>
            <label className="login-campo">
              <span>Username</span>
              <input
                name="chiave"
                autoComplete="username"
                autoFocus
                required
                inputMode="text"
                autoCapitalize="none"
              />
            </label>
            <label className="login-campo">
              <span>Password</span>
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit" className="btn-primary login-invia">
              Entra
            </button>
          </form>
        ) : (
          <>
            <form action={verificaCodiceAction} className="login-form">
              <h1 className="login-titolo">Verifica in due passaggi</h1>
              <p className="hint login-sottotitolo">
                Inserisci il codice a 6 cifre dell&apos;app authenticator. Se hai perso il telefono,
                va bene anche uno dei codici di recupero.
              </p>
              <label className="login-campo">
                <span>Codice</span>
                <input
                  name="codice"
                  autoFocus
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="login-codice"
                />
              </label>
              <button type="submit" className="btn-primary login-invia">
                Verifica
              </button>
            </form>
            <form action={logoutAction} className="login-annulla-form">
              <button type="submit" className="btn-mini login-annulla">
                ← Annulla e ricomincia
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
