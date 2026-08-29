import { operatoreCorrente } from "@/server/auth/sessione";
import { redirect } from "next/navigation";
import { accediAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accesso — GaldieriReviews" };

const MESSAGGI: Record<string, string> = {
  credenziali: "Username o password non corretti.",
  disattivato: "Questo utente è disattivato: chiedi a un amministratore.",
  scaduta: "Sessione scaduta: rientra con username e password.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; m?: string }>;
}) {
  const sp = await searchParams;

  // Già dentro? Alla home.
  if (await operatoreCorrente()) redirect("/");

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
      </section>
    </main>
  );
}
