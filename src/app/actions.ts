"use server";

import { revalidatePath } from "next/cache";
import { setReadState } from "@/server/graph/client";

/** Segna un messaggio come letto o non letto e aggiorna le pagine. */
export async function setReadStateAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const isRead = String(formData.get("isRead") ?? "") === "1";
  if (!id) return;

  await setReadState(id, isRead);

  revalidatePath("/posta");
  revalidatePath("/email");
}
