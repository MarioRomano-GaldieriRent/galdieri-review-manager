"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { caricaRegole, regolaPer, regoleDiDefault, salvaRegole } from "@/server/automation/rules";
import { eseguiRegola } from "@/server/automation/engine";
import { registraEsecuzione, svuotaEsecuzioni } from "@/server/automation/runs";
import { caricaRecensioni, haTesto } from "@/server/reviews/load";
import { loadSettings } from "@/server/settings";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function refresh() {
  revalidatePath("/automazioni");
}

/**
 * Esegue la regola che copre una singola recensione.
 *
 * È sempre a conferma: parte solo da questa azione, mai da sola. In modalità
 * simulazione nessun nodo di scrittura viene eseguito — vedi connectors.ts.
 */
export async function eseguiSuRecensioneAction(formData: FormData): Promise<void> {
  const chiave = str(formData, "chiave");
  const settings = await loadSettings();
  const label = settings.labels.find((l) => l.id === str(formData, "label")) ?? settings.labels[0];
  if (!chiave || !label) redirect("/automazioni");

  const { recensioni } = await caricaRecensioni(label);
  const recensione = recensioni.find((r) => r.chiave === chiave);
  if (!recensione) redirect("/automazioni?errore=recensione-non-trovata");

  const regole = await caricaRegole();
  const regola = regolaPer(regole, recensione.stelle, haTesto(recensione));
  if (!regola) redirect("/automazioni?errore=nessuna-regola");

  const esecuzione = await eseguiRegola(regola, recensione);
  await registraEsecuzione(esecuzione);

  refresh();
  redirect(`/automazioni?run=${encodeURIComponent(esecuzione.id)}`);
}

export async function cambiaStatoRegolaAction(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const regole = await caricaRegole();
  const r = regole.find((x) => x.id === id);
  if (!r) return;
  r.attiva = !r.attiva;
  await salvaRegole(regole);
  refresh();
}

/** Salva i parametri di un nodo (es. il testo della risposta su Google). */
export async function salvaNodoAction(formData: FormData): Promise<void> {
  const regolaId = str(formData, "regolaId");
  const azioneId = str(formData, "azioneId");
  const regole = await caricaRegole();
  const azione = regole.find((r) => r.id === regolaId)?.azioni.find((a) => a.id === azioneId);
  if (!azione) return;

  for (const [chiave, valore] of formData.entries()) {
    if (!chiave.startsWith("p_")) continue;
    azione.parametri[chiave.slice(2)] = String(valore).trim();
  }
  await salvaRegole(regole);
  refresh();
}

export async function ripristinaRegoleAction(): Promise<void> {
  await salvaRegole(regoleDiDefault());
  refresh();
}

export async function svuotaRegistroAction(): Promise<void> {
  await svuotaEsecuzioni();
  refresh();
}
