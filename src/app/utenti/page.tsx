import Link from "next/link";
import { elencoUtenti } from "@/server/auth/utenti";
import { richiediAdmin } from "@/server/auth/sessione";
import { cambiaPasswordAction, creaUtenteAction, impostaAttivoAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Utenti — GaldieriReviews" };

export default async function UtentiPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; e?: string }>;
}) {
  const admin = await richiediAdmin();
  const sp = await searchParams;
  const utenti = await elencoUtenti();

  return (
    <main className="pipeline">
      <div className="dash-centro-testa">
        <div>
          <h1>Utenti</h1>
          <p className="hint">
            Chi può accedere a GaldieriReviews. Ogni azione operativa viene attribuita all&apos;utente
            che l&apos;ha fatta.
          </p>
        </div>
        <Link href="/impostazioni" className="btn-secondary">
          ← Impostazioni
        </Link>
      </div>

      {sp.ok && <p className="notice flag-green-box">{sp.ok}</p>}
      {sp.e && <p className="form-error">{sp.e}</p>}

      {/* ------------------------------------------------- nuovo utente */}
      <section className="card">
        <h2 className="utenti-sez">Nuovo utente</h2>
        <form action={creaUtenteAction} className="utenti-form">
          <label className="login-campo">
            <span>Nome e cognome</span>
            <input name="nome" required placeholder="Mario Romano" />
          </label>
          <label className="login-campo">
            <span>Username</span>
            <input name="chiave" required placeholder="mario" autoCapitalize="none" />
          </label>
          <label className="login-campo">
            <span>Email (facoltativa)</span>
            <input name="email" type="email" placeholder="mario@galdierirent.it" />
          </label>
          <label className="login-campo">
            <span>Ruolo</span>
            <select name="ruolo" defaultValue="operatore">
              <option value="operatore">Operatore</option>
              <option value="admin">Amministratore</option>
            </select>
          </label>
          <label className="login-campo">
            <span>Password iniziale (min 10)</span>
            <input name="password" type="text" required minLength={10} placeholder="almeno 10 caratteri" />
          </label>
          <button type="submit" className="btn-primary">
            Crea utente
          </button>
        </form>
        <p className="hint">Comunica tu la password all&apos;utente. Potrà cambiarla in seguito.</p>
      </section>

      {/* --------------------------------------------------- elenco */}
      <section className="card">
        <h2 className="utenti-sez">Utenti esistenti ({utenti.length})</h2>
        <div className="utenti-tabella-wrap">
          <table className="utenti-tabella">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Username</th>
                <th>Ruolo</th>
                <th>Stato</th>
                <th>Azioni</th>
              </tr>
            </thead>
            <tbody>
              {utenti.map((u) => {
                const sono = u._id === admin._id;
                return (
                  <tr key={u._id} className={u.attivo ? "" : "utente-off"}>
                    <td>
                      {u.nome}
                      {sono && <span className="flag flag-gray">tu</span>}
                    </td>
                    <td className="mono">{u.chiave}</td>
                    <td>{u.ruolo === "admin" ? "Amministratore" : "Operatore"}</td>
                    <td>
                      {u.attivo ? (
                        <span className="flag flag-green">attivo</span>
                      ) : (
                        <span className="flag flag-red">disattivato</span>
                      )}
                    </td>
                    <td className="utenti-azioni">
                      {!sono && (
                        <form action={impostaAttivoAction}>
                          <input type="hidden" name="id" value={u._id} />
                          <input type="hidden" name="attivo" value={u.attivo ? "0" : "1"} />
                          <button type="submit" className="btn-mini">
                            {u.attivo ? "Disattiva" : "Riattiva"}
                          </button>
                        </form>
                      )}
                      <form action={cambiaPasswordAction} className="utenti-pw">
                        <input type="hidden" name="id" value={u._id} />
                        <input
                          name="password"
                          type="text"
                          minLength={10}
                          required
                          placeholder="nuova password"
                          aria-label={`Nuova password per ${u.chiave}`}
                        />
                        <button type="submit" className="btn-mini">
                          Cambia
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Sei entrato come <strong>{admin.nome}</strong>.
        </p>
      </section>
    </main>
  );
}
