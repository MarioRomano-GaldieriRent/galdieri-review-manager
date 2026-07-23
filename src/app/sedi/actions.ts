"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { impostaLinkSede, importaSediCsv } from "@/server/db/sedi";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function salvaLinkSedeAction(formData: FormData): Promise<void> {
  const chiave = str(formData, "chiave");
  if (chiave) {
    await impostaLinkSede(chiave, str(formData, "googleReviewsUrl"), str(formData, "placeId"));
  }
  revalidatePath("/sedi");
  revalidatePath("/da-pubblicare");
  redirect("/sedi?salvata=" + encodeURIComponent(chiave));
}

export async function importaCsvAction(formData: FormData): Promise<void> {
  const csv = String(formData.get("csv") ?? "");
  const esito = await importaSediCsv(csv);
  revalidatePath("/sedi");
  revalidatePath("/da-pubblicare");
  const p = new URLSearchParams({
    imp: "1",
    agg: String(esito.aggiornate),
    ign: String(esito.ignorate),
  });
  if (esito.errori.length) p.set("err", esito.errori.slice(0, 5).join(" · ").slice(0, 300));
  redirect("/sedi?" + p);
}
