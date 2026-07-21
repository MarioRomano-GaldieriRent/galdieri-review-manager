"use server";

import { revalidatePath } from "next/cache";
import { loadSettings, saveSettings, slugify, type Label } from "@/server/settings";

function refresh() {
  revalidatePath("/impostazioni");
  revalidatePath("/recensioni");
  revalidatePath("/");
}

export async function saveMailboxAction(formData: FormData): Promise<void> {
  const settings = await loadSettings();
  settings.mailbox = String(formData.get("mailbox") ?? "").trim();
  await saveSettings(settings);
  refresh();
}

export async function addLabelAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const subjectContains = String(formData.get("subjectContains") ?? "").trim();
  const fromContains = String(formData.get("fromContains") ?? "").trim();
  if (!name || !subjectContains) return;

  const settings = await loadSettings();
  let id = slugify(name);
  if (settings.labels.some((l) => l.id === id)) id = `${id}-${settings.labels.length + 1}`;

  const label: Label = { id, name, subjectContains, fromContains };
  settings.labels.push(label);
  await saveSettings(settings);
  refresh();
}

export async function updateLabelAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const settings = await loadSettings();
  const label = settings.labels.find((l) => l.id === id);
  if (!label) return;

  label.name = String(formData.get("name") ?? label.name).trim() || label.name;
  label.subjectContains =
    String(formData.get("subjectContains") ?? label.subjectContains).trim() ||
    label.subjectContains;
  label.fromContains = String(formData.get("fromContains") ?? "").trim();

  await saveSettings(settings);
  refresh();
}

export async function deleteLabelAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const settings = await loadSettings();
  settings.labels = settings.labels.filter((l) => l.id !== id);
  await saveSettings(settings);
  refresh();
}
