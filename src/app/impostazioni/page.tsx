import Link from "next/link";
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
import {
  descriviCondizione,
  PassoRegola,
  quandoScatta,
  quantiModificano,
} from "../_ui/automazioni";
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

// Le sezioni del pannello. Se ne mostra una alla volta: la pagina unica era
// lunghissima e ci si perdeva fra modalità, regole, parametri e credenziali.
const SEZIONI = [
  { id: "modo", voce: "Modalità operativa", gruppo: "Funzionamento" },
  { id: "regole", voce: "Regole e flussi", gruppo: "Funzionamento" },
  { id: "parametri", voce: "Parametri", gruppo: "Funzionamento" },
  { id: "etichette", voce: "Etichette", gruppo: "Funzionamento" },
  { id: "email", voce: "Email — Microsoft 365", gruppo: "Integrazioni" },
  { id: "freshdesk", voce: "Freshdesk", gruppo: "Integrazioni" },
  { id: "google", voce: "Google Business Profile", gruppo: "Integrazioni" },
  { id: "traduzione", voce: "Traduzione", gruppo: "Integrazioni" },
] as const;

type IdSezione = (typeof SEZIONI)[number]["id"];

/** Le prove di connessione rimandano qui: si torna nella sezione giusta. */
const SEZIONE_DEL_TEST: Record<string, IdSezione> = {
  graph: "email",
  translator: "traduzione",
  freshdesk: "freshdesk",
  modo: "modo",
};

function Stato({ ok, testo }: { ok: boolean; testo: string }) {
  return <span className={`conn-badge ${ok ? "conn-ok" : "conn-ko"}`}>{testo}</span>;
}

export default async function ImpostazioniPage({
  searchParams,
}: {
  searchParams: Promise<{ test?: string; ok?: string; msg?: string; s?: string }>;
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
  const graphOk = isSet(graph.tenantId) && isSet(graph.clientId) && isSet(graph.clientSecret);
  const translatorOk = isSet(translator.key) && isSet(translator.region);
  const freshdeskOk = isSet(freshdesk.domain) && isSet(freshdesk.apiKey);
  const attive = regole.filter((r) => r.attiva).length;

  const richiesta = SEZIONI.find((s) => s.id === sp.s)?.id;
  const sezione: IdSezione =
    richiesta ?? (sp.test ? (SEZIONE_DEL_TEST[sp.test] ?? "modo") : "modo");

  const esito = sp.test ? { quale: sp.test, ok: sp.ok === "1", msg: sp.msg ?? "" } : null;
  const Esito = ({ per }: { per: string }) =>
    esito && esito.quale === per ? (
      <p className={esito.ok ? "test-ok" : "form-error"}>
        {esito.ok ? "✓ " : "✕ "}
        {esito.msg}
      </p>
    ) : null;

  /** Pastiglia di stato accanto alla voce nel menu laterale. */
  const statoVoce = (id: IdSezione) => {
    if (id === "modo") return simulazione ? "simulazione" : "REALE";
    if (id === "regole") return `${attive}/${regole.length}`;
    if (id === "etichette") return String(settings.labels.length);
    if (id === "email") return graphOk ? "ok" : "!";
    if (id === "freshdesk") return freshdeskOk ? "ok" : "!";
    if (id === "traduzione") return translatorOk ? "ok" : "off";
    if (id === "google") return "off";
    return "";
  };
  const vocePreoccupa = (id: IdSezione) =>
    (id === "modo" && !simulazione) ||
    (id === "email" && !graphOk) ||
    (id === "freshdesk" && !freshdeskOk);

  const gruppi = [...new Set(SEZIONI.map((s) => s.gruppo))];

  return (
    <main className="pannello">
      <div className="pannello-testa">
        <h1>Impostazioni</h1>
        <p className="subtitle">
          I valori inseriti qui hanno la precedenza sul file <code>.env</code> e sono salvati in{" "}
          <code>data/settings.json</code>.
        </p>
      </div>

      <div className="pannello-corpo">
        {/* ------------------------------------------------- voci laterali */}
        <nav className="pannello-menu" aria-label="Sezioni delle impostazioni">
          {gruppi.map((g) => (
            <div key={g} className="menu-gruppo">
              <p className="menu-gruppo-titolo">{g}</p>
              {SEZIONI.filter((s) => s.gruppo === g).map((s) => (
                <Link
                  key={s.id}
                  href={`/impostazioni?s=${s.id}`}
                  className={`menu-voce${s.id === sezione ? " is-active" : ""}`}
                  aria-current={s.id === sezione ? "page" : undefined}
                >
                  <span className="menu-voce-testo">{s.voce}</span>
                  <span className={`menu-voce-stato${vocePreoccupa(s.id) ? " ko" : ""}`}>
                    {statoVoce(s.id)}
                  </span>
                </Link>
              ))}
            </div>
          ))}
        </nav>

        {/* --------------------------------------------------- contenuto */}
        <div className="pannello-contenuto">
          {sezione === "modo" && (
            <section className={`card modo-banner ${simulazione ? "modo-sim" : "modo-reale"}`}>
              <div className="sec-head">
                <h2>Modalità operativa</h2>
                <span className={`conn-badge ${simulazione ? "conn-ok" : "conn-ko"}`}>
                  {simulazione ? "simulazione" : "REALE"}
                </span>
              </div>

              <p>
                {simulazione ? (
                  <>
                    Le automazioni <strong>non scrivono nulla</strong> fuori da qui. Leggono i dati
                    veri — così sanno dire quale ticket toccherebbero — ma non modificano Freshdesk,
                    non pubblicano su Google e non inviano posta.
                  </>
                ) : (
                  <>
                    Le automazioni <strong>eseguono davvero</strong>: modificano i ticket e inviano
                    email. Restano comunque a conferma, una recensione alla volta.
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
                  <button
                    type="submit"
                    className={simulazione ? "btn-secondary btn-danger" : "btn-primary"}
                  >
                    {simulazione ? "Attiva modalità reale" : "Torna in simulazione"}
                  </button>
                </div>
              </form>
              <Esito per="modo" />
            </section>
          )}

          {sezione === "regole" && (
            <>
              <section className="card">
                <div className="sec-head">
                  <h2>Regole e flussi</h2>
                  <span className="conn-badge conn-ok">
                    {attive} attive su {regole.length}
                  </span>
                </div>
                <p className="hint">
                  Ogni regola è una catena di passaggi che scatta su un certo tipo di recensione. I
                  valori iniziali ricalcano quello che oggi viene fatto a mano, ricavati leggendo i
                  ticket già presenti su Freshdesk. Le recensioni si lavorano poi dal pannello{" "}
                  <Link href="/automazioni">Automazioni</Link>.
                </p>
                <p className="notice">
                  Nelle regole che rispondono al cliente il testo si scrive due volte, in italiano e
                  in inglese: si usa l&apos;italiano se la recensione è in italiano, altrimenti
                  l&apos;inglese — è come si risponde oggi.
                </p>
              </section>

              {/* Chiuse di default: si apre solo quella che interessa, e
                  aprirne una chiude le altre. */}
              <div className="regole-elenco">
                {regole.map((r) => (
                  <details
                    key={r.id}
                    name="regole"
                    className={`card regola ${r.attiva ? "" : "regola-spenta"}`}
                  >
                    <summary className="regola-testa">
                      <span className="regola-cond">{descriviCondizione(r)}</span>
                      <span className="regola-nome">{r.nome}</span>
                      <span className="regola-conteggio">{r.azioni.length} passaggi</span>
                      <span className={`conn-badge ${r.attiva ? "conn-ok" : "conn-ko"}`}>
                        {r.attiva ? "attiva" : "spenta"}
                      </span>
                      <span className="regola-freccia" aria-hidden="true" />
                    </summary>

                    <div className="regola-dentro">
                      <p className="regola-quando">
                        {quandoScatta(r)}, l&apos;applicazione esegue questi {r.azioni.length}{" "}
                        passaggi in ordine. {quantiModificano(r)}
                      </p>

                      <ol className="passi">
                        {r.azioni.map((a, i) => (
                          <PassoRegola
                            key={a.id}
                            regola={r}
                            azione={a}
                            numero={i + 1}
                            ultimo={i === r.azioni.length - 1}
                          />
                        ))}
                      </ol>

                      <form action={cambiaStatoRegolaAction} className="regola-interruttore">
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className={r.attiva ? "btn-secondary" : "btn-primary"}
                        >
                          {r.attiva ? "Disattiva questa regola" : "Attiva questa regola"}
                        </button>
                        <span className="hint">
                          {r.attiva
                            ? "Disattivandola, le recensioni che copre escono dalla coda in Automazioni."
                            : "Attivandola, le recensioni che copre compaiono nella coda in Automazioni."}
                        </span>
                      </form>
                    </div>
                  </details>
                ))}
              </div>

              <section className="card">
                <h2>Ripristino</h2>
                <p className="hint">
                  Riporta tutte le regole a come sono state scritte all&apos;inizio, perdendo le
                  modifiche fatte ai passaggi.
                </p>
                <form action={ripristinaRegoleAction} style={{ marginTop: 12 }}>
                  <button type="submit" className="btn-secondary">
                    Ripristina regole iniziali
                  </button>
                </form>
              </section>
            </>
          )}

          {sezione === "parametri" && (
            <section className="card">
              <h2>Parametri delle automazioni</h2>
              <p className="hint">
                Valori a cui i passaggi delle regole fanno riferimento, rilevati dai ticket reali di
                Freshdesk.
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
          )}

          {sezione === "email" && (
            <section className="card">
              <div className="sec-head">
                <h2>Email — Microsoft 365</h2>
                <Stato ok={graphOk} testo={graphOk ? "configurata" : "incompleta"} />
              </div>
              <p className="hint">
                Lettura della posta via Microsoft Graph in modalità applicativa. È la sorgente di
                tutto: recensioni, automazioni e ticket partono da qui.
              </p>

              <form action={saveGraphAction}>
                <div className="form-grid">
                  <label className="field">
                    <span>Tenant ID</span>
                    <input
                      name="tenantId"
                      defaultValue={settings.graph.tenantId ?? ""}
                      placeholder={graph.tenantId}
                    />
                  </label>
                  <label className="field">
                    <span>Client ID</span>
                    <input
                      name="clientId"
                      defaultValue={settings.graph.clientId ?? ""}
                      placeholder={graph.clientId}
                    />
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
                    <input
                      name="graphUrl"
                      defaultValue={settings.graph.graphUrl ?? ""}
                      placeholder={graph.graphUrl}
                    />
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
          )}

          {sezione === "traduzione" && (
            <section className="card">
              <div className="sec-head">
                <h2>Traduzione — Azure AI Translator</h2>
                <Stato ok={translatorOk} testo={translatorOk ? "attiva" : "non attiva"} />
              </div>
              <p className="hint">
                Traduce in italiano le recensioni scritte in altre lingue, per leggerle nel pannello
                Recensioni. Piano gratuito F0: 2 milioni di caratteri al mese, e ogni testo si
                traduce una volta sola perché il risultato resta in cache.
              </p>
              <p className="notice">
                Non serve alle automazioni: la scelta fra risposta italiana e inglese si fa senza
                chiamare nessun servizio.
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
          )}

          {sezione === "freshdesk" && (
            <section className="card">
              <div className="sec-head">
                <h2>Freshdesk — ticketing</h2>
                <Stato ok={freshdeskOk} testo={freshdeskOk ? "configurata" : "da configurare"} />
              </div>
              <p className="hint">
                Le credenziali si prendono dal profilo agente Freshdesk → <em>View API Key</em>. Il
                pannello Ticket è di sola lettura; le automazioni scrivono solo in modalità reale.
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
          )}

          {sezione === "google" && (
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
                <strong>Come si attiva.</strong> 1) In Google Cloud Console crea un client OAuth e
                abilita la <em>Business Profile API</em>. 2) Compila il modulo di richiesta accesso:
                Google assegna <strong>quota 0</strong> di default e finché non approva ogni
                chiamata risponde 403. 3) Ottieni una volta sola un refresh token con scope{" "}
                <code>business.manage</code>. Nel frattempo le recensioni continuano ad arrivare via
                email (Zapier), che è la sorgente usata ora.
              </p>
            </section>
          )}

          {sezione === "etichette" && (
            <>
              <section className="card">
                <h2>Etichette ({settings.labels.length})</h2>
                <p className="hint" style={{ marginBottom: 16 }}>
                  Un&apos;etichetta raccoglie le email il cui <strong>oggetto contiene</strong> un
                  testo. Il filtro sul mittente è facoltativo: lascialo vuoto per prendere tutto il
                  flusso.
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
                        <input
                          name="fromContains"
                          defaultValue={l.fromContains}
                          placeholder="es. zapiermail"
                        />
                      </label>
                    </div>
                    <div className="label-actions">
                      <button type="submit" className="btn-mini">
                        Salva modifiche
                      </button>
                      <button
                        type="submit"
                        className="btn-mini btn-danger"
                        formAction={deleteLabelAction}
                      >
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
                      <input
                        name="subjectContains"
                        placeholder="NUOVA RECENSIONE GOOGLE"
                        required
                      />
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
            </>
          )}
        </div>
      </div>
    </main>
  );
}
