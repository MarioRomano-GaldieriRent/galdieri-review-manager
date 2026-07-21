import {
  activeMailbox,
  isSet,
  loadSettings,
  resolveAutomation,
  resolveFreshdesk,
  resolveGoogleReviews,
  resolveGraph,
  resolveTranslator,
} from "@/server/settings";
import { getGoogleReviewsStatus } from "@/server/integrations/googleReviews";
import { caricaRegole } from "@/server/automation/rules";
import { descriviCondizione, NodoEditor } from "../_ui/automazioni";
import {
  addLabelAction,
  cambiaModoAction,
  cambiaStatoRegolaAction,
  deleteLabelAction,
  ripristinaRegoleAction,
  salvaAutomationAction,
  saveFreshdeskAction,
  saveGoogleReviewsAction,
  saveGraphAction,
  saveMailboxAction,
  saveTranslatorAction,
  testFreshdeskAction,
  testGraphAction,
  testTranslatorAction,
  updateLabelAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Impostazioni — Galdieri rent" };

const SEGRETO = "•••••••• (impostato — lascia vuoto per non cambiarlo)";

function Stato({ ok, testo }: { ok: boolean; testo: string }) {
  return <span className={`conn-badge ${ok ? "conn-ok" : "conn-ko"}`}>{testo}</span>;
}

export default async function ImpostazioniPage({
  searchParams,
}: {
  searchParams: Promise<{ test?: string; ok?: string; msg?: string }>;
}) {
  const sp = await searchParams;
  const settings = await loadSettings();
  const [graph, translator, freshdesk, google, mailbox, googleStatus, automation, regole] =
    await Promise.all([
      resolveGraph(settings),
      resolveTranslator(settings),
      resolveFreshdesk(settings),
      resolveGoogleReviews(settings),
      activeMailbox(),
      getGoogleReviewsStatus(),
      resolveAutomation(settings),
      caricaRegole(),
    ]);
  const simulazione = settings.modo !== "reale";

  const esito = sp.test ? { quale: sp.test, ok: sp.ok === "1", msg: sp.msg ?? "" } : null;
  const Esito = ({ per }: { per: string }) =>
    esito && esito.quale === per ? (
      <p className={esito.ok ? "test-ok" : "form-error"}>
        {esito.ok ? "✓ " : "✕ "}
        {esito.msg}
      </p>
    ) : null;

  const graphOk = isSet(graph.tenantId) && isSet(graph.clientId) && isSet(graph.clientSecret);
  const translatorOk = isSet(translator.key) && isSet(translator.region);
  const freshdeskOk = isSet(freshdesk.domain) && isSet(freshdesk.apiKey);

  return (
    <main>
      <h1>Impostazioni</h1>
      <p className="subtitle">
        Configurazione delle integrazioni e delle etichette. I valori inseriti qui hanno la
        precedenza sul file <code>.env</code> e sono salvati in <code>data/settings.json</code>.
      </p>

      {/* ------------------------------------------------ Modalità operativa */}
      <section id="modo" className={`card modo-banner ${simulazione ? "modo-sim" : "modo-reale"}`}>
        <div className="sec-head">
          <h2>Modalità operativa</h2>
          <span className={`conn-badge ${simulazione ? "conn-ok" : "conn-ko"}`}>
            {simulazione ? "simulazione" : "REALE"}
          </span>
        </div>

        <p>
          {simulazione ? (
            <>
              Le automazioni <strong>non scrivono nulla</strong> fuori da qui. Leggono i dati veri —
              così sanno dire quale ticket toccherebbero — ma non modificano Freshdesk, non
              pubblicano su Google e non inviano posta.
            </>
          ) : (
            <>
              Le automazioni <strong>eseguono davvero</strong>: modificano i ticket e inviano email.
              Restano comunque a conferma, una recensione alla volta.
            </>
          )}
        </p>

        <form action={cambiaModoAction} className="filters-row" style={{ marginTop: 12 }}>
          <input type="hidden" name="modo" value={simulazione ? "reale" : "simulazione"} />
          {simulazione && (
            <label className="field grow">
              <span>Per attivare la modalità reale scrivi REALE</span>
              <input name="conferma" placeholder="REALE" autoComplete="off" />
            </label>
          )}
          <div className="filters-actions">
            <button type="submit" className={simulazione ? "btn-secondary btn-danger" : "btn-primary"}>
              {simulazione ? "Attiva modalità reale" : "Torna in simulazione"}
            </button>
          </div>
        </form>
        <Esito per="modo" />
      </section>

      {/* ---------------------------------------------------- Automazioni */}
      <section id="automazioni" className="card">
        <div className="sec-head">
          <h2>Automazioni — regole e flussi</h2>
          <span className="conn-badge conn-ok">
            {regole.filter((r) => r.attiva).length} attive su {regole.length}
          </span>
        </div>
        <p className="hint">
          Ogni regola è una catena di passaggi. I valori iniziali ricalcano quello che oggi viene
          fatto a mano: sono stati ricavati leggendo i ticket recensione già presenti su Freshdesk.
          Apri un nodo per modificarne il contenuto. Le recensioni si lavorano poi dal pannello{" "}
          <a href="/automazioni">Automazioni</a>.
        </p>
        <div className="label-actions">
          <form action={ripristinaRegoleAction}>
            <button type="submit" className="btn-secondary">
              Ripristina regole iniziali
            </button>
          </form>
        </div>
      </section>

      {regole.map((r) => (
        <section key={r.id} className={`card regola ${r.attiva ? "" : "regola-spenta"}`}>
          <div className="sec-head">
            <h2>
              <span className="regola-cond">{descriviCondizione(r)}</span> {r.nome}
            </h2>
            <form action={cambiaStatoRegolaAction}>
              <input type="hidden" name="id" value={r.id} />
              <button type="submit" className={r.attiva ? "btn-mini" : "btn-mini btn-danger"}>
                {r.attiva ? "Attiva — disattiva" : "Disattivata — attiva"}
              </button>
            </form>
          </div>
          <div className="flow">
            {r.azioni.map((a, i) => (
              <div key={a.id} className="flow-step">
                {i > 0 && <span className="flow-freccia">→</span>}
                <NodoEditor regola={r} azione={a} />
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* -------------------------------------------- Parametri automazioni */}
      <section className="card">
        <h2>Parametri delle automazioni</h2>
        <p className="hint">
          Valori usati come riferimento dai nodi qui sopra, rilevati dai ticket reali di Freshdesk.
        </p>
        <form action={salvaAutomationAction}>
          <div className="form-grid">
            <label className="field">
              <span>Email per le recensioni negative</span>
              <input name="emailEscalation" defaultValue={automation.emailEscalation} />
            </label>
            <label className="field">
              <span>Testo dell&apos;inoltro</span>
              <input name="testoEscalation" defaultValue={automation.testoEscalation} />
            </label>
            <label className="field">
              <span>Id agente — recensioni positive</span>
              <input name="agenteMarketing" defaultValue={automation.agenteMarketing} />
            </label>
            <label className="field">
              <span>Id agente — recensioni negative</span>
              <input name="agenteEscalation" defaultValue={automation.agenteEscalation} />
            </label>
            <label className="field">
              <span>Tipo ticket per le recensioni Google</span>
              <input name="tipoTicketGoogle" defaultValue={automation.tipoTicketGoogle} />
            </label>
          </div>
          <button type="submit" className="btn-primary" style={{ marginTop: 12 }}>
            Salva
          </button>
        </form>
      </section>

      {/* ---------------------------------------------------------- Email */}
      <section className="card">
        <div className="sec-head">
          <h2>Email — Microsoft 365</h2>
          <Stato ok={graphOk} testo={graphOk ? "configurata" : "incompleta"} />
        </div>
        <p className="hint">
          Lettura della posta via Microsoft Graph in modalità applicativa. È l&apos;integrazione in
          uso adesso dal pannello Recensioni.
        </p>

        <form action={saveGraphAction}>
          <div className="form-grid">
            <label className="field">
              <span>Tenant ID</span>
              <input name="tenantId" defaultValue={settings.graph.tenantId ?? ""} placeholder={graph.tenantId} />
            </label>
            <label className="field">
              <span>Client ID</span>
              <input name="clientId" defaultValue={settings.graph.clientId ?? ""} placeholder={graph.clientId} />
            </label>
            <label className="field">
              <span>Client secret</span>
              <input
                name="clientSecret"
                type="password"
                autoComplete="off"
                placeholder={isSet(graph.clientSecret) ? SEGRETO : "non impostato"}
              />
            </label>
            <label className="field">
              <span>Endpoint Graph</span>
              <input name="graphUrl" defaultValue={settings.graph.graphUrl ?? ""} placeholder={graph.graphUrl} />
            </label>
          </div>
          <div className="label-actions">
            <button type="submit" className="btn-primary">
              Salva
            </button>
            <button type="submit" className="btn-secondary" formAction={testGraphAction}>
              Prova connessione
            </button>
          </div>
        </form>
        <Esito per="graph" />

        <hr className="sep" />

        <form action={saveMailboxAction} className="filters-row">
          <label className="field grow">
            <span>Casella monitorata (vuoto = quella del .env)</span>
            <input name="mailbox" defaultValue={settings.mailbox} placeholder={mailbox} />
          </label>
          <div className="filters-actions">
            <button type="submit" className="btn-primary">
              Salva casella
            </button>
          </div>
        </form>
        <p className="hint">
          In uso adesso: <strong>{mailbox || "(nessuna)"}</strong>
        </p>
      </section>

      {/* ---------------------------------------------------- Traduzione */}
      <section className="card">
        <div className="sec-head">
          <h2>Traduzione — Azure AI Translator</h2>
          <Stato ok={translatorOk} testo={translatorOk ? "attiva" : "non attiva"} />
        </div>
        <p className="hint">
          Traduce in italiano le recensioni scritte in altre lingue. Piano gratuito F0: 2 milioni di
          caratteri al mese. Le traduzioni sono messe in cache, quindi ogni testo si traduce una
          volta sola.
        </p>

        <form action={saveTranslatorAction}>
          <div className="form-grid">
            <label className="field">
              <span>Chiave</span>
              <input
                name="key"
                type="password"
                autoComplete="off"
                placeholder={isSet(translator.key) ? SEGRETO : "non impostata"}
              />
            </label>
            <label className="field">
              <span>Regione</span>
              <input
                name="region"
                defaultValue={settings.translator.region ?? ""}
                placeholder={translator.region || "es. westeurope"}
              />
            </label>
            <label className="field">
              <span>Endpoint</span>
              <input
                name="endpoint"
                defaultValue={settings.translator.endpoint ?? ""}
                placeholder={translator.endpoint}
              />
            </label>
          </div>
          <div className="label-actions">
            <button type="submit" className="btn-primary">
              Salva
            </button>
            <button type="submit" className="btn-secondary" formAction={testTranslatorAction}>
              Prova connessione
            </button>
          </div>
        </form>
        <Esito per="translator" />
      </section>

      {/* ----------------------------------------------------- Freshdesk */}
      <section className="card">
        <div className="sec-head">
          <h2>Freshdesk — ticketing</h2>
          <Stato ok={freshdeskOk} testo={freshdeskOk ? "configurata" : "da configurare"} />
        </div>
        <p className="hint">
          Le credenziali si prendono dal profilo agente Freshdesk → <em>View API Key</em>. Per ora
          la connessione è solo verificabile: la creazione e la chiusura automatica dei ticket
          arriveranno nel passo successivo.
        </p>

        <form action={saveFreshdeskAction}>
          <div className="form-grid">
            <label className="field">
              <span>Dominio</span>
              <input
                name="domain"
                defaultValue={settings.freshdesk.domain ?? ""}
                placeholder={freshdesk.domain || "azienda.freshdesk.com"}
              />
            </label>
            <label className="field">
              <span>API key</span>
              <input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={isSet(freshdesk.apiKey) ? SEGRETO : "non impostata"}
              />
            </label>
          </div>
          <div className="label-actions">
            <button type="submit" className="btn-primary">
              Salva
            </button>
            <button type="submit" className="btn-secondary" formAction={testFreshdeskAction}>
              Prova connessione
            </button>
          </div>
        </form>
        <Esito per="freshdesk" />
      </section>

      {/* ------------------------------------------------ Google Reviews */}
      <section className="card">
        <div className="sec-head">
          <h2>Google Business Profile — recensioni</h2>
          <Stato
            ok={false}
            testo={googleStatus.configured ? "dati completi, non attiva" : "da configurare"}
          />
        </div>
        <p className="hint">{googleStatus.note}</p>
        {googleStatus.missing.length > 0 && (
          <p className="hint">Mancano: {googleStatus.missing.join(", ")}.</p>
        )}

        <form action={saveGoogleReviewsAction}>
          <div className="form-grid">
            <label className="field">
              <span>Client ID (OAuth)</span>
              <input
                name="clientId"
                defaultValue={settings.googleReviews.clientId ?? ""}
                placeholder={google.clientId || "…apps.googleusercontent.com"}
              />
            </label>
            <label className="field">
              <span>Client secret</span>
              <input
                name="clientSecret"
                type="password"
                autoComplete="off"
                placeholder={isSet(google.clientSecret) ? SEGRETO : "non impostato"}
              />
            </label>
            <label className="field">
              <span>Refresh token</span>
              <input
                name="refreshToken"
                type="password"
                autoComplete="off"
                placeholder={isSet(google.refreshToken) ? SEGRETO : "non impostato"}
              />
            </label>
            <label className="field">
              <span>Account ID</span>
              <input
                name="accountId"
                defaultValue={settings.googleReviews.accountId ?? ""}
                placeholder={google.accountId || "accounts/1234567890"}
              />
            </label>
          </div>
          <button type="submit" className="btn-primary" style={{ marginTop: 12 }}>
            Salva
          </button>
        </form>

        <p className="notice" style={{ marginTop: 14 }}>
          <strong>Come si attiva.</strong> 1) In Google Cloud Console crea un client OAuth e abilita
          la <em>Business Profile API</em>. 2) Compila il modulo di richiesta accesso: Google
          assegna <strong>quota 0</strong> di default e finché non approva ogni chiamata risponde
          403. 3) Ottieni una volta sola un refresh token con scope{" "}
          <code>business.manage</code>. Nel frattempo le recensioni continuano ad arrivare via email
          (Zapier), che è la sorgente usata ora.
        </p>
      </section>

      {/* ------------------------------------------------------ Etichette */}
      <section className="card">
        <h2>Etichette ({settings.labels.length})</h2>
        <p className="hint" style={{ marginBottom: 16 }}>
          Un&apos;etichetta raccoglie le email il cui <strong>oggetto contiene</strong> un testo. Il
          filtro sul mittente è facoltativo: lascialo vuoto per prendere tutto il flusso.
        </p>

        {settings.labels.map((l) => (
          <form key={l.id} action={updateLabelAction} className="label-row">
            <input type="hidden" name="id" value={l.id} />
            <div className="form-grid">
              <label className="field">
                <span>Nome etichetta</span>
                <input name="name" defaultValue={l.name} required />
              </label>
              <label className="field">
                <span>Oggetto contiene</span>
                <input name="subjectContains" defaultValue={l.subjectContains} required />
              </label>
              <label className="field">
                <span>Mittente contiene (facoltativo)</span>
                <input name="fromContains" defaultValue={l.fromContains} placeholder="es. zapiermail" />
              </label>
            </div>
            <div className="label-actions">
              <button type="submit" className="btn-mini">
                Salva modifiche
              </button>
              <button type="submit" className="btn-mini btn-danger" formAction={deleteLabelAction}>
                Elimina
              </button>
            </div>
          </form>
        ))}
      </section>

      <section className="card">
        <h2>Aggiungi etichetta</h2>
        <form action={addLabelAction}>
          <div className="form-grid">
            <label className="field">
              <span>Nome etichetta</span>
              <input name="name" placeholder="Recensioni di Google" required />
            </label>
            <label className="field">
              <span>Oggetto contiene</span>
              <input name="subjectContains" placeholder="NUOVA RECENSIONE GOOGLE" required />
            </label>
            <label className="field">
              <span>Mittente contiene (facoltativo)</span>
              <input name="fromContains" placeholder="lascia vuoto per tutti" />
            </label>
          </div>
          <button type="submit" className="btn-primary" style={{ marginTop: 12 }}>
            Aggiungi
          </button>
        </form>
      </section>
    </main>
  );
}
