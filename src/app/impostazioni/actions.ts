"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { loadSettings, saveSettings, slugify, type Label } from "@/server/settings";
import { testGraphConnection } from "@/server/graph/client";
import { testTranslator } from "@/server/translate";
import { testFreshdesk } from "@/server/integrations/freshdesk";

function refresh() {
  revalidatePath("/impostazioni");
  revalidatePath("/recensioni");
  revalidatePath("/automazioni");
  revalidatePath("/");
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** I campi segreti si lasciano vuoti per non modificarli. */
const keep = (nuovo: string, vecchio: string | undefined) => (nuovo ? nuovo : (vecchio ?? ""));

// ---------------------------------------------------------------- etichette

export async function saveMailboxAction(formData: FormData): Promise<void> {
  const settings = await loadSettings();
  settings.mailbox = str(formData, "mailbox");
  await saveSettings(settings);
  refresh();
}

export async function addLabelAction(formData: FormData): Promise<void> {
  const name = str(formData, "name");
  const subjectContains = str(formData, "subjectContains");
  if (!name || !subjectContains) return;

  const settings = await loadSettings();
  let id = slugify(name);
  if (settings.labels.some((l) => l.id === id)) id = `${id}-${settings.labels.length + 1}`;

  const label: Label = { id, name, subjectContains, fromContains: str(formData, "fromContains") };
  settings.labels.push(label);
  await saveSettings(settings);
  refresh();
}

export async function updateLabelAction(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const settings = await loadSettings();
  const label = settings.labels.find((l) => l.id === id);
  if (!label) return;

  label.name = str(formData, "name") || label.name;
  label.subjectContains = str(formData, "subjectContains") || label.subjectContains;
  label.fromContains = str(formData, "fromContains");
  await saveSettings(settings);
  refresh();
}

export async function deleteLabelAction(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const settings = await loadSettings();
  settings.labels = settings.labels.filter((l) => l.id !== id);
  await saveSettings(settings);
  refresh();
}

// ------------------------------------------------------- modalità operativa

/**
 * Passa da simulazione a reale e viceversa.
 *
 * Per accendere la modalità reale bisogna scrivere a mano la parola REALE: è
 * l'ultima barriera prima che le automazioni possano modificare ticket veri e
 * inviare email vere. Spegnerla non richiede nulla.
 */
export async function cambiaModoAction(formData: FormData): Promise<void> {
  const richiesto = str(formData, "modo");
  const s = await loadSettings();

  if (richiesto === "reale") {
    if (str(formData, "conferma").toUpperCase() !== "REALE") {
      redirect("/impostazioni?test=modo&ok=0&msg=" + encodeURIComponent(
        "Per attivare la modalità reale scrivi REALE nella casella di conferma.",
      ));
    }
    s.modo = "reale";
  } else {
    s.modo = "simulazione";
  }

  await saveSettings(s);
  refresh();
  redirect(
    "/impostazioni?test=modo&ok=1&msg=" +
      encodeURIComponent(
        s.modo === "reale"
          ? "Modalità REALE attiva: le automazioni eseguite modificheranno davvero ticket e posta."
          : "Modalità simulazione attiva: nessuna scrittura verso l'esterno.",
      ),
  );
}

export async function salvaAutomationAction(formData: FormData): Promise<void> {
  const s = await loadSettings();
  s.automation = {
    emailEscalation: str(formData, "emailEscalation"),
    testoEscalation: str(formData, "testoEscalation"),
    agenteMarketing: str(formData, "agenteMarketing"),
    agenteEscalation: str(formData, "agenteEscalation"),
    tipoTicketGoogle: str(formData, "tipoTicketGoogle"),
  };
  await saveSettings(s);
  refresh();
}

// ------------------------------------------------------------- integrazioni

export async function saveGraphAction(formData: FormData): Promise<void> {
  const s = await loadSettings();
  s.graph = {
    tenantId: str(formData, "tenantId"),
    clientId: str(formData, "clientId"),
    clientSecret: keep(str(formData, "clientSecret"), s.graph.clientSecret),
    graphUrl: str(formData, "graphUrl"),
  };
  await saveSettings(s);
  refresh();
}

export async function saveTranslatorAction(formData: FormData): Promise<void> {
  const s = await loadSettings();
  s.translator = {
    key: keep(str(formData, "key"), s.translator.key),
    region: str(formData, "region"),
    endpoint: str(formData, "endpoint"),
  };
  await saveSettings(s);
  refresh();
}

export async function saveFreshdeskAction(formData: FormData): Promise<void> {
  const s = await loadSettings();
  s.freshdesk = {
    domain: str(formData, "domain"),
    apiKey: keep(str(formData, "apiKey"), s.freshdesk.apiKey),
  };
  await saveSettings(s);
  refresh();
}

export async function saveGoogleReviewsAction(formData: FormData): Promise<void> {
  const s = await loadSettings();
  s.googleReviews = {
    clientId: str(formData, "clientId"),
    clientSecret: keep(str(formData, "clientSecret"), s.googleReviews.clientSecret),
    refreshToken: keep(str(formData, "refreshToken"), s.googleReviews.refreshToken),
    accountId: str(formData, "accountId"),
  };
  await saveSettings(s);
  refresh();
}

// ------------------------------------------------------- prove di connessione

function vaiAlRisultato(quale: string, ok: boolean, message: string): never {
  const p = new URLSearchParams({ test: quale, ok: ok ? "1" : "0", msg: message.slice(0, 300) });
  redirect(`/impostazioni?${p}`);
}

export async function testGraphAction(): Promise<void> {
  const r = await testGraphConnection();
  vaiAlRisultato("graph", r.ok, r.message);
}

export async function testTranslatorAction(): Promise<void> {
  const r = await testTranslator();
  vaiAlRisultato("translator", r.ok, r.message);
}

export async function testFreshdeskAction(): Promise<void> {
  const r = await testFreshdesk();
  vaiAlRisultato("freshdesk", r.ok, r.message);
}
