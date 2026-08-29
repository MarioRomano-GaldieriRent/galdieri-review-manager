"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cambiaPassword, creaUtente, impostaAttivo, type Ruolo } from "@/server/auth/utenti";
import { richiediAdmin } from "@/server/auth/sessione";

// Gestione utenti: solo admin. Ogni azione ricontrolla il ruolo (le server
// action sono endpoint a sé) e attribuisce la modifica all'admin che la fa.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function torna(msg: Record<string, string> = {}): never {
  const p = new URLSearchParams(msg);
  const s = p.toString();
  redirect(s ? `/utenti?${s}` : "/utenti");
}

export async function creaUtenteAction(formData: FormData): Promise<void> {
  const admin = await richiediAdmin();
  const chiave = str(formData, "chiave");
  const nome = str(formData, "nome");
  const email = str(formData, "email");
  const ruolo: Ruolo = str(formData, "ruolo") === "admin" ? "admin" : "operatore";
  const password = String(formData.get("password") ?? "");

  try {
    await creaUtente({ chiave, nome, email, ruolo, password, creatoDa: admin._id });
  } catch (e) {
    torna({ e: e instanceof Error ? e.message : "Creazione non riuscita" });
  }
  revalidatePath("/utenti");
  torna({ ok: `Utente "${chiave}" creato.` });
}

export async function impostaAttivoAction(formData: FormData): Promise<void> {
  const admin = await richiediAdmin();
  const id = Number(str(formData, "id"));
  const attivo = str(formData, "attivo") === "1";
  if (id === admin._id) torna({ e: "Non puoi disattivare te stesso." });
  try {
    await impostaAttivo(id, attivo, admin._id);
  } catch (e) {
    torna({ e: e instanceof Error ? e.message : "Operazione non riuscita" });
  }
  revalidatePath("/utenti");
  torna({ ok: attivo ? "Utente riattivato." : "Utente disattivato." });
}

export async function cambiaPasswordAction(formData: FormData): Promise<void> {
  const admin = await richiediAdmin();
  const id = Number(str(formData, "id"));
  const password = String(formData.get("password") ?? "");
  try {
    await cambiaPassword(id, password, admin._id);
  } catch (e) {
    torna({ e: e instanceof Error ? e.message : "Cambio password non riuscito" });
  }
  revalidatePath("/utenti");
  torna({ ok: "Password aggiornata." });
}
