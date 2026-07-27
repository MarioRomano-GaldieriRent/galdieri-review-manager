import { linkGoogle, type VocePubblicazione } from "@/server/db/pubblicazioni";
import { CopiaRisposta } from "./CopiaRisposta";
import {
  annullaPubblicazioneAction,
  confermaOnlineAction,
  riprovaFreshdeskAction,
  segnalaSparitaAction,
  segnaPubblicataAction,
} from "./actions";

// Componenti della coda di pubblicazione, estratti dalla pagina così la home
// (che ora ospita l'intera pipeline) li riusa senza duplicarli.

export function Stelle({ n }: { n: number | null }) {
  const v = n ?? 0;
  return (
    <span className={`stars-badge stars-${v}`} title={n ? `${n} su 5` : "senza punteggio"}>
      {"★".repeat(v)}
      <span className="stars-empty">{"★".repeat(5 - v)}</span>
    </span>
  );
}

export function EsitoFreshdesk({ v }: { v: VocePubblicazione }) {
  if (v.freshdeskEsito === "ok") return <span className="flag flag-green">ticket chiuso</span>;
  if (v.freshdeskEsito === "noniniziato")
    return <span className="flag flag-gray">ticket non toccato (simulazione)</span>;
  const testo =
    v.freshdeskEsito === "inattesa"
      ? `chiusura ticket in retry (tentativo ${v.freshdeskTentativi})`
      : "chiusura ticket non riuscita";
  return (
    <span className="pub-fd-ko">
      <span className="flag flag-red">Freshdesk: {testo}</span>
      <form action={riprovaFreshdeskAction}>
        <input type="hidden" name="chiave" value={v.chiave} />
        <button type="submit" className="btn-mini">
          Riprova
        </button>
      </form>
    </span>
  );
}

export function VoceRicontrollo({ v, numero }: { v: VocePubblicazione; numero: number }) {
  const link = linkGoogle(v);
  const scaduto = v.promemoriaVerificaIl
    ? new Date(v.promemoriaVerificaIl).getTime() <= Date.now()
    : true;
  const ore = v.promemoriaVerificaIl
    ? Math.round((new Date(v.promemoriaVerificaIl).getTime() - Date.now()) / 3600000)
    : 0;

  return (
    <li className="card pub-card">
      <div className="pub-testa">
        <span className="pub-numero" aria-hidden="true">
          {numero}
        </span>
        <div className="pub-autore">
          <span className="review-name">{v.nomeCliente}</span>
          {v.sedeNome && <span className="dash-lingua">{v.sedeNome}</span>}
          <span className={`flag ${scaduto ? "flag-amber" : "flag-gray"}`}>
            {scaduto ? "pronta da ricontrollare" : `fra ~${ore}h`}
          </span>
          <EsitoFreshdesk v={v} />
        </div>
        <Stelle n={v.stelle} />
      </div>

      <div className="pub-risposta">
        <span className="pub-etichetta">Risposta pubblicata</span>
        <p className="pub-risposta-testo">{v.testoRisposta}</p>
      </div>

      <div className="pub-controlli">
        <a className="btn-secondary" href={link.url} target="_blank" rel="noopener noreferrer">
          Apri su Google ↗
        </a>
        <form action={confermaOnlineAction}>
          <input type="hidden" name="chiave" value={v.chiave} />
          <button type="submit" className="btn-primary">
            Confermata online
          </button>
        </form>
        <form action={segnalaSparitaAction}>
          <input type="hidden" name="chiave" value={v.chiave} />
          <button type="submit" className="btn-secondary btn-danger">
            Sparita — ripubblica
          </button>
        </form>
        <form action={annullaPubblicazioneAction}>
          <input type="hidden" name="chiave" value={v.chiave} />
          <button type="submit" className="btn-mini">
            Annulla pubblicazione
          </button>
        </form>
      </div>
    </li>
  );
}

export function VoceCoda({
  v,
  numero,
  sedeSel,
  stelleSel,
}: {
  v: VocePubblicazione;
  numero: number;
  sedeSel: string | null;
  stelleSel: number | null;
}) {
  const link = linkGoogle(v);
  return (
    <li className="card pub-card">
      <div className="pub-testa">
        <span className="pub-numero" aria-hidden="true">
          {numero}
        </span>
        <div className="pub-autore">
          <span className="review-name">{v.nomeCliente}</span>
          <span className="dash-fonte">{v.origine === "google" ? "Google" : "Trustpilot"}</span>
          {v.sedeNome && <span className="dash-lingua">{v.sedeNome}</span>}
          {v.ripubblicazioni > 0 && (
            <span className="flag flag-amber">ripubblicazione #{v.ripubblicazioni}</span>
          )}
        </div>
        <Stelle n={v.stelle} />
      </div>

      {v.testoRecensione && <p className="pub-recensione">«{v.testoRecensione}»</p>}

      <div className="pub-risposta">
        <span className="pub-etichetta">Risposta da pubblicare</span>
        <p className="pub-risposta-testo">{v.testoRisposta}</p>
      </div>

      <div className="pub-controlli">
        <a className="btn-secondary" href={link.url} target="_blank" rel="noopener noreferrer">
          Apri su Google ↗
        </a>
        <CopiaRisposta testo={v.testoRisposta} />
        <form action={segnaPubblicataAction} data-segna>
          <input type="hidden" name="chiave" value={v.chiave} />
          <input type="hidden" name="sede" value={sedeSel ?? ""} />
          <input type="hidden" name="stelle" value={stelleSel ?? ""} />
          <button type="submit" className="btn-primary">
            Segna come pubblicata
          </button>
        </form>
      </div>

      {link.generico && (
        <p className="hint pub-link-generico">
          Nessun link diretto per questa sede: si apre la gestione recensioni generica, cerca «
          {v.sedeNome || "la sede"}». Puoi impostare il link diretto nella pagina Sedi.
        </p>
      )}
    </li>
  );
}
