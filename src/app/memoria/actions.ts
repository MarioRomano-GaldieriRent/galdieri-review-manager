"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { richiediAdmin } from "@/server/auth/sessione";
import {
  aggiornaBlocco,
  creaBlocco,
  eliminaBlocco,
  eliminaEsempio,
  impostaAttivoBlocco,
  impostaAttivoEsempio,
  impostaAttivoGruppo,
  parseLingua,
  parseStato,
  parseTipo,
  type FiltriEsempi,
} from "@/server/db/memoria";

// Pannello Memoria: solo admin. Ogni azione ricontrolla il ruolo (le server
// action sono endpoint a sé) e torna alla stessa vista (stessi filtri/pagina).

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Le sole chiavi di query che si riportano indietro: niente redirect fuori dal pannello. */
const CHIAVI_RITORNO = ["tipo", "lingua", "sede", "q", "stato", "pagina"];

function torna(fd: FormData, msg: Record<string, string>): never {
  const grezzo = new URLSearchParams(str(fd, "ritorno"));
  const p = new URLSearchParams();
  for (const k of CHIAVI_RITORNO) {
    const v = grezzo.get(k);
    if (v) p.set(k, v);
  }
  for (const [k, v] of Object.entries(msg)) p.set(k, v);
  revalidatePath("/memoria");
  const s = p.toString();
  redirect(s ? `/memoria?${s}` : "/memoria");
}

function filtriDa(fd: FormData): FiltriEsempi {
  return {
    tipo: parseTipo(str(fd, "tipo") || undefined),
    lingua: parseLingua(str(fd, "lingua") || undefined),
    sede: str(fd, "sede") || undefined,
    q: str(fd, "q") || undefined,
    stato: parseStato(str(fd, "stato") || undefined),
  };
}

// ------------------------------------------------------------- contesto

export async function creaBloccoAction(fd: FormData): Promise<void> {
  await richiediAdmin();
  const titolo = str(fd, "titolo");
  const testo = String(fd.get("testo") ?? "").trim();
  if (!titolo) torna(fd, { e: "Il blocco ha bisogno di un titolo." });
  let msg: Record<string, string>;
  try {
    await creaBlocco(titolo, testo);
    msg = { ok: `Blocco «${titolo}» aggiunto al contesto.` };
  } catch (e) {
    msg = { e: e instanceof Error ? e.message : "Creazione non riuscita" };
  }
  torna(fd, msg);
}

export async function salvaBloccoAction(fd: FormData): Promise<void> {
  await richiediAdmin();
  const chiave = str(fd, "chiave");
  const titolo = str(fd, "titolo");
  const testo = String(fd.get("testo") ?? "").trim();
  if (!chiave || !titolo) torna(fd, { e: "Titolo mancante." });
  let msg: Record<string, string>;
  try {
    msg = (await aggiornaBlocco(chiave, { titolo, testo }))
      ? { ok: `Blocco «${titolo}» salvato.` }
      : { e: "Blocco non trovato." };
  } catch (e) {
    msg = { e: e instanceof Error ? e.message : "Salvataggio non riuscito" };
  }
  torna(fd, msg);
}

export async function impostaBloccoAttivoAction(fd: FormData): Promise<void> {
  await richiediAdmin();
  const chiave = str(fd, "chiave");
  const attivo = str(fd, "attivo") === "1";
  let msg: Record<string, string>;
  try {
    msg = (await impostaAttivoBlocco(chiave, attivo))
      ? { ok: attivo ? "Blocco incluso nel contesto." : "Blocco escluso dal contesto." }
      : { e: "Blocco non trovato." };
  } catch (e) {
    msg = { e: e instanceof Error ? e.message : "Operazione non riuscita" };
  }
  torna(fd, msg);
}

export async function eliminaBloccoAction(fd: FormData): Promise<void> {
  await richiediAdmin();
  const chiave = str(fd, "chiave");
  let msg: Record<string, string>;
  try {
    msg = (await eliminaBlocco(chiave))
      ? { ok: "Blocco eliminato." }
      : { e: "Blocco non trovato." };
  } catch (e) {
    msg = { e: e instanceof Error ? e.message : "Eliminazione non riuscita" };
  }
  torna(fd, msg);
}

// -------------------------------------------------------------- esempi

export async function impostaEsempioAttivoAction(fd: FormData): Promise<void> {
  await richiediAdmin();
  const chiave = str(fd, "chiave");
  const attivo = str(fd, "attivo") === "1";
  let msg: Record<string, string>;
  try {
    msg = (await impostaAttivoEsempio(chiave, attivo))
      ? { ok: attivo ? "Risposta inclusa nel contesto." : "Risposta esclusa dal contesto." }
      : { e: "Risposta non trovata." };
  } catch (e) {
    msg = { e: e instanceof Error ? e.message : "Operazione non riuscita" };
  }
  torna(fd, msg);
}

export async function eliminaEsempioAction(fd: FormData): Promise<void> {
  await richiediAdmin();
  const chiave = str(fd, "chiave");
  let msg: Record<string, string>;
  try {
    msg = (await eliminaEsempio(chiave))
      ? { ok: "Risposta eliminata dalla memoria (non tornerà con le prossime importazioni)." }
      : { e: "Risposta non trovata." };
  } catch (e) {
    msg = { e: e instanceof Error ? e.message : "Eliminazione non riuscita" };
  }
  torna(fd, msg);
}

/** Includi/escludi in blocco tutte le risposte che rispondono ai filtri passati. */
export async function impostaGruppoAttivoAction(fd: FormData): Promise<void> {
  await richiediAdmin();
  const filtri = filtriDa(fd);
  const attivo = str(fd, "attivo") === "1";
  // Senza nessun criterio si toccherebbe TUTTA la memoria: si rifiuta.
  if (!filtri.tipo && !filtri.lingua && !filtri.sede && !filtri.q && filtri.stato === "tutte") {
    torna(fd, { e: "Scegli almeno un filtro prima di includere/escludere in blocco." });
  }
  let msg: Record<string, string>;
  try {
    const n = await impostaAttivoGruppo(filtri, attivo);
    msg = { ok: `${n} risposte ${attivo ? "incluse nel" : "escluse dal"} contesto.` };
  } catch (e) {
    msg = { e: e instanceof Error ? e.message : "Operazione non riuscita" };
  }
  torna(fd, msg);
}
