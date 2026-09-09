"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { richiediAdmin, richiediOperatore } from "@/server/auth/sessione";
import { segnaChiusa } from "@/server/db/escalation";
import { leggiRecensione, segnaGestitaFuoriPortale } from "@/server/db/recensioni";
import { chiudiSegnalazione, leggiSegnalazione, segnala } from "@/server/db/segnalazioni";
import { avvisaAdminDiSegnalazione } from "@/server/notifiche/segnalazione";

// Le azioni della segnalazione. La guardia sta QUI, dentro ogni azione: il
// middleware non valida la sessione. Segnalare lo fa chiunque sia loggato;
// risolvere e rimettere in coda solo l'admin.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** «il 9 settembre alle 12:24»: per dire QUANDO era già stata segnalata. */
const fmtQuando = new Intl.DateTimeFormat("it-IT", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * L'indirizzo con cui raggiungere il gestionale, per il tasto dentro la mail.
 *
 * Si ricava dall'indirizzo che sta usando in questo momento chi segnala (header
 * Host): se Stefania lavora su http://IP:4000, il link punta lì e funziona per
 * chiunque sia nella stessa rete. `APP_URL` nel .env ha la precedenza, per
 * quando ci sarà un nome vero o l'HTTPS.
 */
async function indirizzoApp(): Promise<string> {
  const forzato = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (forzato) return forzato;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:4000";
  const protocollo = h.get("x-forwarded-proto") ?? "http";
  return `${protocollo}://${host}`;
}

/** L'operatore passa all'amministratore una recensione che non riesce a gestire. */
export type EsitoSegnalazione = { ok: true; messaggio: string } | { ok: false; errore: string };

/**
 * Segnala una recensione all'amministratore. DEVE essere istantanea: è un clic.
 *
 * Perché prima non lo era, e cosa è cambiato:
 *  - si finiva con un redirect alla home, che è la pagina lenta (legge la posta
 *    e interroga Freshdesk): il clic sembrava piantato per decine di secondi.
 *    Ora l'azione RITORNA un esito e non naviga: la card si aggiorna sul posto.
 *  - la mail all'admin veniva attesa prima di rispondere. Ora parte con
 *    `after()`, cioè DOPO che la risposta è già stata mandata al browser: chi
 *    segnala non aspetta la posta.
 *  - niente `revalidatePath`: rigenererebbe la home — di nuovo posta e
 *    Freshdesk — proprio mentre si vuole essere veloci. La lista si aggiorna da
 *    sola al prossimo caricamento o con l'auto-aggiornamento.
 *
 * Resta veloce anche quando la posta è rotta: un guasto di Graph non tocca più
 * il tempo di risposta, si vede solo nei log.
 */
export async function segnalaAction(chiave: string, notaGrezza: string): Promise<EsitoSegnalazione> {
  // Le server action sono endpoint a sé: la sessione si ricontrolla qui.
  const op = await richiediOperatore();
  const nota = (notaGrezza ?? "").trim().slice(0, 1000);
  if (!chiave) return { ok: false, errore: "Recensione non indicata." };
  if (!nota) return { ok: false, errore: "Scrivi qual è il problema prima di segnalare." };

  const r = await leggiRecensione(chiave);
  if (!r) return { ok: false, errore: "Recensione non trovata in archivio." };

  // Una sola segnalazione per volta. Se ce n'è già una aperta si esce SUBITO:
  // niente riscrittura e nessuna seconda mail all'admin. Vale per il doppio
  // clic, per il tasto premuto su una pagina vecchia e per il «Indietro».
  const creata = await segnala(r, nota, op._id);
  if (!creata) {
    const gia = await leggiSegnalazione(chiave);
    const quando = gia ? fmtQuando.format(new Date(gia.segnalataIl)) : "poco fa";
    return {
      ok: false,
      errore: `Era già stata segnalata ${quando}: la sta guardando l'amministratore. Non serve rimandarla.`,
    };
  }

  // Il link si costruisce ADESSO, finché la richiesta c'è: dentro after() gli
  // header della richiesta non sono un appiglio su cui contare.
  const link = `${await indirizzoApp()}/supervisione`;
  const daChi = op.nome || op.chiave;

  // La mail parte DOPO la risposta: chi ha premuto non la aspetta.
  after(async () => {
    const avviso = await avvisaAdminDiSegnalazione({ recensione: r, nota, daChi, link });
    console.log(
      avviso.inviata
        ? `[segnalazione] avviso inviato a ${avviso.motivo}`
        : `[segnalazione] avviso NON inviato: ${avviso.motivo}`,
    );
  });

  return {
    ok: true,
    messaggio: `«${r.nome || "La recensione"}» è passata all'amministratore.`,
  };
}

/**
 * L'admin CHIUDE: la recensione è già stata gestita e non deve più tornare da
 * nessuna parte.
 *
 * Chiude su tutti e tre i fronti, perché su tutti e tre una recensione può
 * ricomparire:
 *   1. la segnalazione passa a «risolta» → fuori dalla coda dell'operatore;
 *   2. la recensione è segnata come gestita e archiviata → non può più rientrare
 *      in «Da approvare» (che filtra su `haRisposta: false`) e nelle statistiche
 *      smette di risultare non gestita; resta leggibile in «Archiviate», col
 *      motivo e il tasto «Ripristina»;
 *   3. l'eventuale escalation passa a «chiusa» → non resta appesa una voce
 *      «pronta» o «in attesa» nel ciclo del customer care.
 *
 * Prima si chiudeva solo il punto 1: spariva dalla vista di Stefania ma per il
 * sistema restava aperta, continuava a contare fra le non gestite e — se la
 * segnalazione veniva rimessa in coda — poteva ripresentarsi.
 */
export async function chiudiGiaGestitaAction(formData: FormData): Promise<void> {
  const admin = await richiediAdmin();
  const chiave = str(formData, "chiave");
  if (chiave) {
    const nota = str(formData, "nota").slice(0, 1000);
    await chiudiSegnalazione(chiave, "risolta", nota, admin._id);
    // Il motivo finisce sotto la card in «Archiviate»: se l'admin non scrive
    // nulla ci va comunque una frase che dica da dove arriva la chiusura,
    // altrimenti fra un mese quella riga è muta.
    await segnaGestitaFuoriPortale(
      chiave,
      nota || "Chiusa dalla Supervisione: già gestita fuori dal portale.",
    );
    await segnaChiusa(chiave);
  }
  revalidatePath("/supervisione");
  revalidatePath("/");
  redirect("/supervisione");
}

/** L'admin la rimanda all'operatore: ricompare in «Da approvare». */
export async function rimettiInCodaSegnalazioneAction(formData: FormData): Promise<void> {
  const admin = await richiediAdmin();
  const chiave = str(formData, "chiave");
  if (chiave) await chiudiSegnalazione(chiave, "rimessa", str(formData, "nota").slice(0, 1000), admin._id);
  revalidatePath("/supervisione");
  revalidatePath("/");
  redirect("/supervisione");
}
