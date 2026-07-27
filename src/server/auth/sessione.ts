import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { coll } from "@/server/db/connessione";
import { hashToken, nuovoTokenSessione } from "./crypto";
import { COOKIE_SESSIONE } from "./nomeCookie";
import type { OperatoreDoc } from "./utenti";

// ---------------------------------------------------------------------------
// Sessioni di login. Il cookie contiene un token opaco; nel DB si salva solo il
// suo hash (sessioni._id). Due fasi:
//   attesa_totp — passata la sola password, in attesa del secondo fattore
//   completa    — secondo fattore superato: l'utente è dentro
// Alla promozione il token viene rigenerato (niente fissazione di sessione).
// ---------------------------------------------------------------------------

export type StatoSessione = "attesa_totp" | "completa";

const DURATA_COMPLETA_MS = 12 * 60 * 60 * 1000; // 12 ore
const DURATA_ATTESA_MS = 10 * 60 * 1000; // 10 minuti per fare il secondo fattore
const RINFRESCA_USO_MS = 5 * 60 * 1000; // aggiorna "ultimo uso" al più ogni 5 min

interface SessioneDoc {
  _id: string;
  operatoreId: number;
  statoAutenticazione: StatoSessione;
  creataIl: Date;
  scadeIl: Date;
  ultimoUsoIl: Date;
  userAgent?: string;
  ip?: string;
}

async function sessioni() {
  return coll("sessioni");
}

/** Crea una sessione nello stato dato e imposta il cookie. Ritorna il token. */
export async function creaSessione(operatoreId: number, stato: StatoSessione): Promise<void> {
  const token = nuovoTokenSessione();
  const ora = new Date();
  const scade = new Date(ora.getTime() + (stato === "completa" ? DURATA_COMPLETA_MS : DURATA_ATTESA_MS));
  const ua = (await headers()).get("user-agent") ?? "";

  await (await sessioni()).insertOne({
    _id: hashToken(token),
    operatoreId,
    statoAutenticazione: stato,
    creataIl: ora,
    scadeIl: scade,
    ultimoUsoIl: ora,
    userAgent: ua.slice(0, 300),
    ip: "",
  });

  (await cookies()).set(COOKIE_SESSIONE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // In locale (http) il flag secure impedirebbe l'invio del cookie: si accende
    // solo in produzione, dove il sito è servito in https.
    secure: process.env.NODE_ENV === "production",
    expires: scade,
  });
}

/** La sessione valida corrente (qualunque stato), o null. */
async function leggiSessione(): Promise<SessioneDoc | null> {
  const token = (await cookies()).get(COOKIE_SESSIONE)?.value;
  if (!token) return null;

  const s = (await (await sessioni()).findOne({ _id: hashToken(token) })) as unknown as SessioneDoc | null;
  if (!s) return null;
  // Il TTL di Mongo potrebbe non averla ancora rimossa: si ricontrolla qui.
  if (new Date(s.scadeIl).getTime() <= Date.now()) return null;

  // "Ultimo uso" aggiornato con parsimonia, non a ogni render.
  if (Date.now() - new Date(s.ultimoUsoIl).getTime() > RINFRESCA_USO_MS) {
    try {
      await (await sessioni()).updateOne({ _id: s._id }, { $set: { ultimoUsoIl: new Date() } });
    } catch {
      // non critico
    }
  }
  return s;
}

/** L'operatore loggato (solo sessioni complete), con il profilo aggiornato. */
export async function operatoreCorrente(): Promise<OperatoreDoc | null> {
  const s = await leggiSessione();
  if (!s || s.statoAutenticazione !== "completa") return null;
  const op = (await (await coll("operatori")).findOne({
    _id: s.operatoreId,
    attivo: true,
  })) as unknown as OperatoreDoc | null;
  return op ?? null;
}

/** Come operatoreCorrente, ma rimanda a /login se non c'è nessuno. */
export async function richiediOperatore(): Promise<OperatoreDoc> {
  const op = await operatoreCorrente();
  if (!op) redirect("/login");
  return op;
}

/** true se l'operatore corrente ha un certo ruolo (o admin, che può tutto). */
export async function haRuolo(ruolo: string): Promise<boolean> {
  const op = await operatoreCorrente();
  return Boolean(op && (op.ruolo === ruolo || op.ruolo === "admin"));
}

/** Solo admin: rimanda a /login se non lo è. */
export async function richiediAdmin(): Promise<OperatoreDoc> {
  const op = await richiediOperatore();
  if (op.ruolo !== "admin") redirect("/");
  return op;
}

/** La sessione in attesa del secondo fattore (fra password e TOTP), o null. */
export async function sessionePendente(): Promise<{ operatoreId: number } | null> {
  const s = await leggiSessione();
  if (!s || s.statoAutenticazione !== "attesa_totp") return null;
  return { operatoreId: s.operatoreId };
}

/**
 * Promuove il login a "completa" superato il secondo fattore. Rigenera il token
 * (nuova riga, cookie nuovo) e butta la sessione d'attesa: così un token
 * catturato durante la fase password non vale nulla dopo il TOTP.
 */
export async function completaLogin(operatoreId: number): Promise<void> {
  await distruggiSessione();
  await creaSessione(operatoreId, "completa");
}

/** Logout: cancella la sessione dal DB e rimuove il cookie. */
export async function distruggiSessione(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_SESSIONE)?.value;
  if (token) {
    try {
      await (await sessioni()).deleteOne({ _id: hashToken(token) });
    } catch {
      // se il DB non risponde, si toglie comunque il cookie
    }
  }
  jar.delete(COOKIE_SESSIONE);
}
