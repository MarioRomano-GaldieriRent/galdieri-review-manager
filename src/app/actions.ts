"use server";

import { revalidatePath } from "next/cache";
import { setReadState } from "@/server/graph/client";
import { richiediOperatore } from "@/server/auth/sessione";

/** Segna un messaggio come letto o non letto e aggiorna le pagine. */
export async function setReadStateAction(formData: FormData): Promise<void> {
  // Scrive davvero sulla casella (PATCH Graph): serve una sessione valida. Il
  // middleware non basta (controlla solo la presenza del cookie).
  await richiediOperatore();
  const id = String(formData.get("id") ?? "");
  const isRead = String(formData.get("isRead") ?? "") === "1";
  if (!id) return;

  await setReadState(id, isRead);

  revalidatePath("/posta");
  revalidatePath("/email");
}
