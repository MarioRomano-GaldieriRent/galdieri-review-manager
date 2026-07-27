import QRCode from "qrcode";
import { redirect } from "next/navigation";
import { leggiOperatore, preparaTotp, segretoTotpInCorso, totpAttivo } from "@/server/auth/utenti";
import { sessionePendente } from "@/server/auth/sessione";
import { chiaveCifraturaPronta, otpauthUri } from "@/server/auth/crypto";
import { ConfermaTotp } from "./ConfermaTotp";

export const dynamic = "force-dynamic";
export const metadata = { title: "Attiva la verifica in due passaggi — GaldieriReviews" };

/** Il secret in gruppi di 4, più leggibile per l'inserimento a mano. */
function aGruppi(s: string): string {
  return (s.match(/.{1,4}/g) ?? [s]).join(" ");
}

export default async function AttivaTotpPage() {
  // Ci si arriva subito dopo la password, con la sessione in attesa del TOTP.
  const pend = await sessionePendente();
  if (!pend) redirect("/login");
  // Chi ha già il TOTP attivo non enrolla: deve solo inserire il codice.
  if (await totpAttivo(pend.operatoreId)) redirect("/login?fase=codice");

  // Senza AUTH_ENC_KEY non si può cifrare il secret: si ferma con un messaggio
  // chiaro invece di esplodere a metà.
  if (!chiaveCifraturaPronta()) {
    return (
      <main className="login-schermo">
        <section className="login-box card">
          <h1 className="login-titolo">Configurazione mancante</h1>
          <p className="form-error">
            Manca la chiave <code>AUTH_ENC_KEY</code> nel file <code>.env</code>: serve per
            proteggere il secret della verifica in due passaggi. Impostala e riprova.
          </p>
        </section>
      </main>
    );
  }

  const op = await leggiOperatore(pend.operatoreId);
  const account = op?.chiave ?? "utente";

  // Secret stabile: se ce n'è già uno in preparazione si riusa, così il QR non
  // cambia a ogni refresh mentre lo si inquadra.
  const segreto = (await segretoTotpInCorso(pend.operatoreId)) ?? (await preparaTotp(pend.operatoreId));
  const uri = otpauthUri(segreto, account);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });

  return (
    <main className="login-schermo">
      <section className="login-box login-box-larga card">
        <h1 className="login-titolo">Attiva la verifica in due passaggi</h1>
        <p className="hint login-sottotitolo">
          Da ora, oltre alla password serve un codice che cambia ogni 30 secondi. Ti serve
          un&apos;app authenticator: Google Authenticator, Microsoft Authenticator, Aegis, Authy…
        </p>

        <ol className="totp-passi">
          <li>
            <strong>Inquadra il QR</strong> con l&apos;app.
            <div className="totp-qr">
              {/* Immagine generata sul server, incorporata come data URI. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="Codice QR per l'app authenticator" width={220} height={220} />
            </div>
            <p className="hint">
              Non puoi scansionare? Inserisci la chiave a mano:
              <br />
              <code className="totp-chiave">{aGruppi(segreto)}</code>
            </p>
          </li>
          <li>
            <strong>Inserisci il codice</strong> che compare nell&apos;app, per confermare.
            <ConfermaTotp />
          </li>
        </ol>
      </section>
    </main>
  );
}
