"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { caricaRegole, regolaPer } from "@/server/automation/rules";
import { eseguiRegola } from "@/server/automation/engine";
import { registraEsecuzione, svuotaEsecuzioni } from "@/server/automation/runs";
import { caricaRecensioni, haTesto } from "@/server/reviews/load";
import { loadSettings } from "@/server/settings";

// Azioni operative del pannello Automazioni: far partire un flusso su una
// recensione e gestire il registro. Le regole invece si configurano in
// Impostazioni — vedi impostazioni/actions.ts.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

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

  revalidatePath("/automazioni");
  redirect(`/automazioni?run=${encodeURIComponent(esecuzione.id)}`);
}

export async function svuotaRegistroAction(): Promise<void> {
  await svuotaEsecuzioni();
  revalidatePath("/automazioni");
}
