import Link from "next/link";
import { richiediAdmin } from "@/server/auth/sessione";
import {
  LINGUE,
  TIPI,
  contaGruppi,
  elencoBlocchi,
  elencoEsempi,
  parseLingua,
  parseStato,
  parseTipo,
  riepilogoEsempi,
  seedContestoSeVuoto,
  type Esempio,
  type FiltriEsempi,
  type LinguaEsempio,
  type TipoEsempio,
} from "@/server/db/memoria";
import { Stelle } from "../da-pubblicare/Voci";
import {
  creaBloccoAction,
  eliminaBloccoAction,
  eliminaEsempioAction,
  impostaBloccoAttivoAction,
  impostaEsempioAttivoAction,
  impostaGruppoAttivoAction,
  salvaBloccoAction,
} from "./actions";

// MEMORIA — ciò che il modello "saprà" quando genererà una risposta:
//   1. il CONTESTO per rispondere: blocchi di testo (chi siamo, tono, regole);
//   2. gli ESEMPI: le risposte vere scritte da Stefania, con la recensione a cui
//      rispondevano, raggruppate per tipo × lingua. Ognuna si include/esclude;
//      «Elimina» la toglie per sempre (anche dalle prossime importazioni).
// Si riempie con `npm run memoria:importa -- 12` (ultimi 12 mesi di Posta inviata).

export const dynamic = "force-dynamic";
export const metadata = { title: "Memoria — GaldieriReviews" };

const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" });
const PER_PAGINA = 40;

type Sp = {
  tipo?: string;
  lingua?: string;
  sede?: string;
  q?: string;
  stato?: string;
  pagina?: string;
  ok?: string;
  e?: string;
};

const nomeLingua = (l: LinguaEsempio) => LINGUE.find((x) => x.id === l)?.nome ?? l;
const nomeTipo = (t: TipoEsempio) => TIPI.find((x) => x.id === t)?.nome ?? t;

/** Query string dei filtri correnti: per i link e per tornare qui dopo un'azione. */
function qs(f: FiltriEsempi, pagina?: number): string {
  const p = new URLSearchParams();
  if (f.tipo) p.set("tipo", f.tipo);
  if (f.lingua) p.set("lingua", f.lingua);
  if (f.sede) p.set("sede", f.sede);
  if (f.q) p.set("q", f.q);
  if (f.stato && f.stato !== "tutte") p.set("stato", f.stato);
  if (pagina && pagina > 1) p.set("pagina", String(pagina));
  return p.toString();
}

/** Campi nascosti con i filtri: per includere/escludere in blocco «queste». */
function CampiFiltri({ f, ritorno }: { f: FiltriEsempi; ritorno: string }) {
  return (
    <>
      <input type="hidden" name="tipo" value={f.tipo ?? ""} />
      <input type="hidden" name="lingua" value={f.lingua ?? ""} />
      <input type="hidden" name="sede" value={f.sede ?? ""} />
      <input type="hidden" name="q" value={f.q ?? ""} />
      <input type="hidden" name="stato" value={f.stato ?? "tutte"} />
      <input type="hidden" name="ritorno" value={ritorno} />
    </>
  );
}

function BottoniGruppo({
  f,
  ritorno,
  n,
  attive,
}: {
  f: FiltriEsempi;
  ritorno: string;
  n: number;
  attive: number;
}) {
  return (
    <>
      {attive < n && (
        <form action={impostaGruppoAttivoAction}>
          <CampiFiltri f={f} ritorno={ritorno} />
          <input type="hidden" name="attivo" value="1" />
          <button
            type="submit"
            className="btn-mini"
            title="Includi nel contesto tutte queste risposte"
          >
            Includi tutte
          </button>
        </form>
      )}
      {attive > 0 && (
        <form action={impostaGruppoAttivoAction}>
          <CampiFiltri f={f} ritorno={ritorno} />
          <input type="hidden" name="attivo" value="0" />
          <button
            type="submit"
            className="btn-mini"
            title="Escludi dal contesto tutte queste risposte"
          >
            Escludi tutte
          </button>
        </form>
      )}
    </>
  );
}

function VoceEsempio({ e, ritorno }: { e: Esempio; ritorno: string }) {
  return (
    <article className={`memoria-voce${e.attivo ? "" : " is-off"}`}>
      <div className="memoria-testa">
        <Stelle n={e.stelle} />
        <span className="review-name">{e.nomeCliente || "(senza nome)"}</span>
        {e.sedeNome && <span className="review-place">{e.sedeNome}</span>}
        <span className="review-date">{fmt.format(new Date(e.inviataIl))}</span>
        <span className="flag flag-gray">{nomeLingua(e.lingua)}</span>
        {e.origine === "customer-care" && (
          <span
            className="flag flag-amber"
            title="Il testo lo aveva scritto il customer care; Stefania l'ha solo rimandato"
          >
            testo del customer care
          </span>
        )}
        <span className={`flag ${e.attivo ? "flag-green" : "flag-gray"}`}>
          {e.attivo ? "nel contesto" : "escluso"}
        </span>
      </div>
      {e.commento ? (
        <p className="memoria-commento">«{e.commento}»</p>
      ) : (
        <p className="memoria-commento muted">— nessun commento, solo punteggio —</p>
      )}
      <p className="memoria-risposta">{e.risposta}</p>
      <div className="memoria-azioni">
        <form action={impostaEsempioAttivoAction}>
          <input type="hidden" name="chiave" value={e.chiave} />
          <input type="hidden" name="attivo" value={e.attivo ? "0" : "1"} />
          <input type="hidden" name="ritorno" value={ritorno} />
          <button type="submit" className="btn-mini">
            {e.attivo ? "Escludi dal contesto" : "Includi nel contesto"}
          </button>
        </form>
        <form action={eliminaEsempioAction}>
          <input type="hidden" name="chiave" value={e.chiave} />
          <input type="hidden" name="ritorno" value={ritorno} />
          <button
            type="submit"
            className="btn-mini"
            title="Toglie la risposta dalla memoria, per sempre"
          >
            Elimina
          </button>
        </form>
      </div>
    </article>
  );
}

export default async function MemoriaPage({ searchParams }: { searchParams: Promise<Sp> }) {
  await richiediAdmin();
  const sp = await searchParams;
  await seedContestoSeVuoto();

  const filtri: FiltriEsempi = {
    tipo: parseTipo(sp.tipo),
    lingua: parseLingua(sp.lingua),
    sede: sp.sede?.trim() || undefined,
    q: sp.q?.trim() || undefined,
    stato: parseStato(sp.stato),
  };
  const pagina = Math.max(1, Number(sp.pagina) || 1);
  // Con un filtro si passa dalla vista a GRUPPI (conteggi) all'ELENCO delle voci.
  const dettaglio = Boolean(
    filtri.tipo || filtri.lingua || filtri.sede || filtri.q || filtri.stato !== "tutte",
  );
  const ritorno = qs(filtri, pagina);

  const [blocchi, riepilogo, gruppi, lista] = await Promise.all([
    elencoBlocchi(),
    riepilogoEsempi(),
    contaGruppi({}),
    dettaglio ? elencoEsempi(filtri, { pagina, perPagina: PER_PAGINA }) : Promise.resolve(null),
  ]);
  const pagine = lista ? Math.max(1, Math.ceil(lista.totale / PER_PAGINA)) : 1;

  return (
    <main className="pipeline">
      <div className="dash-centro-testa">
        <div>
          <h1>Memoria</h1>
          <p className="hint">
            Ciò che il modello saprà quando genererà una risposta: il <b>contesto</b> (chi siamo,
            tono, regole) e gli <b>esempi</b> veri di Stefania. Tutto si include o si esclude qui.
          </p>
        </div>
        <Link href="/impostazioni" className="btn-secondary">
          ← Impostazioni
        </Link>
      </div>

      {sp.ok && <p className="notice flag-green-box">{sp.ok}</p>}
      {sp.e && <p className="form-error">{sp.e}</p>}

      {/* ================================================ contesto */}
      <section className="card">
        <h2 className="utenti-sez">Contesto per rispondere</h2>
        <p className="hint">
          Blocchi di testo liberi. I primi due sono bozze: modificali come vuoi. Solo quelli «nel
          contesto» verranno letti dal modello.
        </p>

        {blocchi.map((b) => (
          <article key={b.chiave} className={`memoria-blocco${b.attivo ? "" : " is-off"}`}>
            <form action={salvaBloccoAction}>
              <input type="hidden" name="chiave" value={b.chiave} />
              <input type="hidden" name="ritorno" value={ritorno} />
              <label className="login-campo">
                <span>Titolo</span>
                <input name="titolo" defaultValue={b.titolo} required />
              </label>
              <label className="login-campo">
                <span>Testo</span>
                <textarea name="testo" defaultValue={b.testo} rows={5} />
              </label>
              <div className="memoria-azioni">
                <button type="submit" className="btn-mini">
                  Salva
                </button>
                <span className={`flag ${b.attivo ? "flag-green" : "flag-gray"}`}>
                  {b.attivo ? "nel contesto" : "escluso"}
                </span>
                <span className="muted small">
                  aggiornato {fmt.format(new Date(b.aggiornataIl))}
                </span>
              </div>
            </form>
            <div className="memoria-azioni">
              <form action={impostaBloccoAttivoAction}>
                <input type="hidden" name="chiave" value={b.chiave} />
                <input type="hidden" name="attivo" value={b.attivo ? "0" : "1"} />
                <input type="hidden" name="ritorno" value={ritorno} />
                <button type="submit" className="btn-mini">
                  {b.attivo ? "Escludi dal contesto" : "Includi nel contesto"}
                </button>
              </form>
              <form action={eliminaBloccoAction}>
                <input type="hidden" name="chiave" value={b.chiave} />
                <input type="hidden" name="ritorno" value={ritorno} />
                <button type="submit" className="btn-mini">
                  Elimina
                </button>
              </form>
            </div>
          </article>
        ))}

        <details className="memoria-nuovo">
          <summary>+ Aggiungi un blocco</summary>
          <form action={creaBloccoAction}>
            <input type="hidden" name="ritorno" value={ritorno} />
            <label className="login-campo">
              <span>Titolo</span>
              <input name="titolo" required placeholder="es. Frasi da evitare" />
            </label>
            <label className="login-campo">
              <span>Testo</span>
              <textarea name="testo" rows={4} placeholder="Scrivi qui le indicazioni…" />
            </label>
            <div className="memoria-azioni">
              <button type="submit" className="btn-primary">
                Aggiungi
              </button>
            </div>
          </form>
        </details>
      </section>

      {/* ================================================= esempi */}
      <section className="card">
        <h2 className="utenti-sez">Risposte di Stefania</h2>
        <p className="memoria-riepilogo">
          <span>
            <b>{riepilogo.totale}</b> risposte
          </span>
          <span>
            <b>{riepilogo.attive}</b> nel contesto
          </span>
          <span>
            <b>{riepilogo.escluse}</b> escluse
          </span>
          {riepilogo.daCustomerCare > 0 && (
            <span>
              <b>{riepilogo.daCustomerCare}</b> col testo del customer care
            </span>
          )}
          {riepilogo.dal && riepilogo.al && (
            <span>
              dal <b>{fmt.format(new Date(riepilogo.dal))}</b> al{" "}
              <b>{fmt.format(new Date(riepilogo.al))}</b>
            </span>
          )}
        </p>
        {riepilogo.totale === 0 && (
          <p className="hint">
            La memoria è vuota. Riempila con <code>npm run memoria:importa -- 12</code> (ultimi 12
            mesi di Posta inviata).
          </p>
        )}

        <form method="get" action="/memoria" className="memoria-filtri">
          <label>
            Tipo
            <select name="tipo" defaultValue={filtri.tipo ?? ""}>
              <option value="">Tutti</option>
              {TIPI.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nome}
                </option>
              ))}
            </select>
          </label>
          <label>
            Lingua
            <select name="lingua" defaultValue={filtri.lingua ?? ""}>
              <option value="">Tutte</option>
              {LINGUE.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nome}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stato
            <select name="stato" defaultValue={filtri.stato}>
              <option value="tutte">Tutte</option>
              <option value="attive">Nel contesto</option>
              <option value="escluse">Escluse</option>
            </select>
          </label>
          <label>
            Sede
            <input name="sede" defaultValue={filtri.sede ?? ""} placeholder="es. Olbia" />
          </label>
          <label>
            Cerca
            <input name="q" defaultValue={filtri.q ?? ""} placeholder="nome, testo…" />
          </label>
          <button type="submit" className="btn-secondary">
            Filtra
          </button>
          {dettaglio && (
            <Link href="/memoria" className="btn-mini">
              Azzera
            </Link>
          )}
        </form>

        {!dettaglio &&
          TIPI.map((t) => {
            const righe = gruppi.filter((g) => g.tipo === t.id);
            const n = righe.reduce((s, g) => s + g.n, 0);
            const attive = righe.reduce((s, g) => s + g.attive, 0);
            return (
              <div key={t.id} className="memoria-gruppo">
                <div className="memoria-gruppo-testa">
                  <h3>{t.nome}</h3>
                  <span className="muted">
                    {n} {n === 1 ? "risposta" : "risposte"} · {attive} nel contesto
                  </span>
                  {n > 0 && (
                    <Link href={`/memoria?${qs({ tipo: t.id })}`} className="btn-mini">
                      Vedi tutte →
                    </Link>
                  )}
                </div>
                {t.descrizione && <p className="hint memoria-gruppo-desc">{t.descrizione}</p>}
                {LINGUE.map((l) => {
                  const g = righe.find((r) => r.lingua === l.id);
                  if (!g) return null;
                  const fl: FiltriEsempi = { tipo: t.id, lingua: l.id };
                  return (
                    <div key={l.id} className="memoria-sottogruppo">
                      <span>
                        <b>{l.nome}</b>: {g.n} · {g.attive} nel contesto
                      </span>
                      <Link href={`/memoria?${qs(fl)}`} className="btn-mini">
                        Vedi →
                      </Link>
                      <BottoniGruppo f={fl} ritorno="" n={g.n} attive={g.attive} />
                    </div>
                  );
                })}
              </div>
            );
          })}

        {dettaglio && lista && (
          <>
            <div className="memoria-gruppo-testa">
              <h3>
                {filtri.tipo ? nomeTipo(filtri.tipo) : "Tutte le risposte"}
                {filtri.lingua ? ` · ${nomeLingua(filtri.lingua)}` : ""}
              </h3>
              <span className="muted">
                {lista.totale} {lista.totale === 1 ? "risposta" : "risposte"}
                {pagine > 1 ? ` · pagina ${pagina} di ${pagine}` : ""}
              </span>
              <BottoniGruppo
                f={filtri}
                ritorno={ritorno}
                n={lista.totale}
                attive={lista.voci.some((v) => v.attivo) ? lista.totale : 0}
              />
            </div>
            {lista.voci.length === 0 && <p className="hint">Nessuna risposta con questi filtri.</p>}
            {lista.voci.map((e) => (
              <VoceEsempio key={e.chiave} e={e} ritorno={ritorno} />
            ))}
            {pagine > 1 && (
              <nav className="memoria-pagine" aria-label="Pagine">
                {pagina > 1 && (
                  <Link href={`/memoria?${qs(filtri, pagina - 1)}`} className="btn-mini">
                    ← Precedenti
                  </Link>
                )}
                <span className="muted">
                  pagina {pagina} di {pagine}
                </span>
                {pagina < pagine && (
                  <Link href={`/memoria?${qs(filtri, pagina + 1)}`} className="btn-mini">
                    Successive →
                  </Link>
                )}
              </nav>
            )}
          </>
        )}
      </section>
    </main>
  );
}
