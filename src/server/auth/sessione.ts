import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { coll } from "@/server/db/connessione";
import { hashToken, nuovoTokenSessione } from "./crypto";
import { COOKIE_SESSIONE } from "./nomeCookie";
import type { OperatoreDoc } from "./utenti";

// ---------------------------------------------------------------------------
// Sessioni di login. Il cookie contiene un token opaco; nel DB si salva solo il
// suo hash (sessioni._id). L'accesso è a un solo fattore: superata la password
// la sessione nasce già "completa". L'indice TTL su scadeIl le fa sparire sole.
// ---------------------------------------------------------------------------

export type StatoSessione = "completa";

const DURATA_MS = 12 * 60 * 60 * 1000; // 12 ore
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

/**
 * Deve il cookie avere il flag `secure`?
 *
 * `secure` fa sì che il browser mandi il cookie SOLO su HTTPS. In produzione, di
 * norma, è quello che vogliamo. Ma se l'app gira su un PC-server in ufficio,
 * raggiunto in LAN via http://IP:porta, un cookie `secure` non verrebbe MAI
 * inviato e il login sembrerebbe non funzionare (si torna sempre al login).
 *
 * Per quel caso si può forzare con la variabile d'ambiente AUTH_COOKIE_SECURE:
 *   - "0"/"false"  → niente secure (server LAN in HTTP)
 *   - "1"/"true"   → sempre secure (dietro reverse proxy / HTTPS)
 *   - non impostata → secure solo in produzione (comportamento storico)
 *
 * Nota: senza `secure`, su una rete non fidata le credenziali e il cookie
 * viaggiano in chiaro. Vale la pena metterci un HTTPS (anche self-signed o un
 * reverse proxy) e lasciare AUTH_COOKIE_SECURE=1.
 */
function cookieSecure(): boolean {
  const v = (process.env.AUTH_COOKIE_SECURE ?? "").toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return process.env.NODE_ENV === "production";
}

/** Crea la sessione (completa) e imposta il cookie. */
export async function creaSessione(operatoreId: number): Promise<void> {
  const token = nuovoTokenSessione();
  const ora = new Date();
  const scade = new Date(ora.getTime() + DURATA_MS);
  const ua = (await headers()).get("user-agent") ?? "";

  await (await sessioni()).insertOne({
    _id: hashToken(token),
    operatoreId,
    statoAutenticazione: "completa",
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
    secure: cookieSecure(),
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
