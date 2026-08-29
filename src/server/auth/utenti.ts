import { coll } from "@/server/db/connessione";
import { OPERATORE_SISTEMA, registraAttivita } from "@/server/db/attivita";
import { hashPassword, verificaPassword } from "./crypto";

// ---------------------------------------------------------------------------
// Utenti e credenziali. Un "utente" è un operatore di tipo "persona" (collezione
// operatori, già esistente) con una riga di credenziali collegata per _id. Il
// profilo e i segreti restano in due collezioni diverse: qui si toccano insieme
// solo dove serve, e il resto dell'app continua a vedere solo operatori.
//
// L'accesso è a UN SOLO fattore: username + password. Nessun TOTP/2FA.
// ---------------------------------------------------------------------------

export type Ruolo = "admin" | "operatore";

export interface OperatoreDoc {
  _id: number;
  chiave: string;
  nome: string;
  email: string | null;
  tipo: string;
  ruolo: string;
  attivo: boolean;
  diSistema: boolean;
  creatoIl: Date;
  disattivatoIl: Date | null;
}

interface CredenzialeDoc {
  _id: number;
  hashPassword: string;
  tentativiFalliti: number;
  bloccatoFinoA: Date | null;
  creataIl: Date;
  aggiornataIl: Date;
}

// Difesa forza bruta: dopo troppi tentativi falliti consecutivi, blocco a tempo.
const MAX_TENTATIVI = 5;
const BLOCCO_MINUTI = 15;
const BLOCCO_MS = BLOCCO_MINUTI * 60000;

/**
 * Incremento ATOMICO del contatore di tentativi falliti e blocco a tempo quando
 * supera la soglia: findOneAndUpdate con pipeline, così N richieste concorrenti
 * non azzerano il lockout (niente read-modify-write). Ritorna true se, dopo
 * questo tentativo, l'account risulta bloccato.
 */
async function registraTentativoFallito(operatoreId: number): Promise<boolean> {
  const r = (await (
    await credenziali()
  ).findOneAndUpdate(
    { _id: operatoreId },
    [
      { $set: { _n: { $add: [{ $ifNull: ["$tentativiFalliti", 0] }, 1] } } },
      {
        $set: {
          bloccatoFinoA: {
            $cond: [
              { $gte: ["$_n", MAX_TENTATIVI] },
              { $add: ["$$NOW", BLOCCO_MS] },
              "$bloccatoFinoA",
            ],
          },
          tentativiFalliti: { $cond: [{ $gte: ["$_n", MAX_TENTATIVI] }, 0, "$_n"] },
          aggiornataIl: "$$NOW",
        },
      },
      { $unset: "_n" },
    ],
    { returnDocument: "after" },
  )) as unknown as CredenzialeDoc | null;
  return Boolean(r?.bloccatoFinoA && new Date(r.bloccatoFinoA).getTime() > Date.now());
}

async function operatori() {
  return coll("operatori");
}
async function credenziali() {
  return coll("credenziali");
}

// ------------------------------------------------------------- lettura

/** L'operatore-persona con quella chiave (username), attivo o meno. */
export async function trovaPerChiave(chiave: string): Promise<OperatoreDoc | null> {
  const op = await (await operatori()).findOne({ chiave, tipo: "persona" });
  return (op as unknown as OperatoreDoc) ?? null;
}

/** L'operatore con quell'id, o null. */
export async function leggiOperatore(operatoreId: number): Promise<OperatoreDoc | null> {
  const op = await (await operatori()).findOne({ _id: operatoreId });
  return (op as unknown as OperatoreDoc) ?? null;
}

async function leggiCredenziale(operatoreId: number): Promise<CredenzialeDoc | null> {
  const c = await (await credenziali()).findOne({ _id: operatoreId });
  return (c as unknown as CredenzialeDoc) ?? null;
}

/** Elenco degli utenti-persona per la pagina di gestione. */
export async function elencoUtenti(): Promise<(OperatoreDoc & { haCredenziali: boolean })[]> {
  const ops = (await (await operatori())
    .find({ tipo: "persona" })
    .sort({ attivo: -1, nome: 1 })
    .toArray()) as unknown as OperatoreDoc[];
  const creds = (await (await credenziali()).find({}).toArray()) as unknown as CredenzialeDoc[];
  const conCred = new Set(creds.map((c) => c._id));
  return ops.map((o) => ({ ...o, haCredenziali: conCred.has(o._id) }));
}

// ------------------------------------------------------- creazione utente

/**
 * Prossimo id operatore, atomico. Allinea il contatore al massimo id già
 * presente (Sistema=1, eventuali operatori travasati) prima di incrementare,
 * così due processi non assegnano mai lo stesso numero.
 */
async function prossimoIdOperatore(): Promise<number> {
  const maxDoc = (await (await operatori())
    .find({})
    .sort({ _id: -1 })
    .limit(1)
    .next()) as unknown as OperatoreDoc | null;
  const max = typeof maxDoc?._id === "number" ? maxDoc._id : OPERATORE_SISTEMA;
  const r = await (
    await coll("contatori")
  ).findOneAndUpdate(
    { _id: "operatori" },
    [{ $set: { valore: { $toInt: { $add: [{ $max: [{ $ifNull: ["$valore", 0] }, max] }, 1] } } } }],
    { upsert: true, returnDocument: "after" },
  );
  return (r as unknown as { valore: number }).valore;
}

/** Crea un utente-persona (operatore + credenziali). Ritorna il nuovo id. */
export async function creaUtente(dati: {
  chiave: string;
  nome: string;
  email?: string;
  ruolo: Ruolo;
  password: string;
  creatoDa?: number;
}): Promise<number> {
  const chiave = dati.chiave.trim().toLowerCase();
  if (!chiave) throw new Error("La chiave utente (username) non può essere vuota.");
  if (dati.password.length < 10) throw new Error("La password deve avere almeno 10 caratteri.");
  if (await trovaPerChiave(chiave)) throw new Error(`Esiste già un utente "${chiave}".`);

  const id = await prossimoIdOperatore();
  const ora = new Date();
  await (await operatori()).insertOne({
    _id: id,
    chiave,
    nome: dati.nome.trim() || chiave,
    email: dati.email?.trim() || null,
    tipo: "persona",
    ruolo: dati.ruolo,
    attivo: true,
    diSistema: false,
    creatoIl: ora,
    disattivatoIl: null,
  });
  await (await credenziali()).insertOne({
    _id: id,
    hashPassword: hashPassword(dati.password),
    tentativiFalliti: 0,
    bloccatoFinoA: null,
    creataIl: ora,
    aggiornataIl: ora,
  });
  await registraAttivita("utente.creato", {
    operatoreId: dati.creatoDa ?? OPERATORE_SISTEMA,
    oggettoTipo: "operatore",
    oggettoId: String(id),
    dettaglio: `${chiave} (${dati.ruolo})`,
  });
  return id;
}

/** Attiva/disattiva un utente. Sistema non si tocca. */
export async function impostaAttivo(
  operatoreId: number,
  attivo: boolean,
  da = OPERATORE_SISTEMA,
): Promise<void> {
  if (operatoreId === OPERATORE_SISTEMA) throw new Error("L'operatore Sistema non si disattiva.");
  await (await operatori()).updateOne(
    { _id: operatoreId, tipo: "persona" },
    { $set: { attivo, disattivatoIl: attivo ? null : new Date() } },
  );
  await registraAttivita(attivo ? "utente.riattivato" : "utente.disattivato", {
    operatoreId: da,
    oggettoTipo: "operatore",
    oggettoId: String(operatoreId),
  });
}

/** Cambia la password di un utente (usato dalla gestione e dal cambio proprio). */
export async function cambiaPassword(
  operatoreId: number,
  nuova: string,
  da = OPERATORE_SISTEMA,
): Promise<void> {
  if (nuova.length < 10) throw new Error("La password deve avere almeno 10 caratteri.");
  await (await credenziali()).updateOne(
    { _id: operatoreId },
    {
      $set: {
        hashPassword: hashPassword(nuova),
        tentativiFalliti: 0,
        bloccatoFinoA: null,
        aggiornataIl: new Date(),
      },
    },
  );
  // Cambiare la password chiude TUTTE le sessioni aperte dell'utente: se una era
  // stata rubata (es. sniffing su HTTP di LAN), il reset la invalida subito
  // invece di lasciarla valida fino alla scadenza (12h). Senza questo, il reset
  // password non caccerebbe davvero l'intruso.
  try {
    await (await coll("sessioni")).deleteMany({ operatoreId });
  } catch {
    // Non blocca il cambio password: la sessione scadrà comunque da sola.
  }
  await registraAttivita("utente.password_cambiata", {
    operatoreId: da,
    oggettoTipo: "operatore",
    oggettoId: String(operatoreId),
  });
}

// ---------------------------------------------------------------- accesso

export type EsitoAccesso =
  | { ok: true; operatoreId: number; nome: string }
  | { ok: false; motivo: "credenziali" | "bloccato" | "disattivato"; minutiBlocco?: number };

/**
 * Verifica username + password. Applica il lockout e non svela se lo username
 * esista: quando manca, esegue comunque un confronto fittizio, così la durata
 * della risposta non distingue "utente inesistente" da "password sbagliata".
 */
export async function verificaAccesso(
  chiaveGrezza: string,
  password: string,
): Promise<EsitoAccesso> {
  const chiave = chiaveGrezza.trim().toLowerCase();
  const op = await trovaPerChiave(chiave);
  const cred = op ? await leggiCredenziale(op._id) : null;

  if (!op || !cred) {
    // Confronto fittizio per pareggiare i tempi (anti-enumerazione).
    verificaPassword(password, "scrypt$16384$8$1$00$00");
    return { ok: false, motivo: "credenziali" };
  }

  const ora = Date.now();
  if (cred.bloccatoFinoA && new Date(cred.bloccatoFinoA).getTime() > ora) {
    const minutiBlocco = Math.ceil((new Date(cred.bloccatoFinoA).getTime() - ora) / 60000);
    return { ok: false, motivo: "bloccato", minutiBlocco };
  }

  // La password si verifica SEMPRE prima di guardare lo stato dell'account: così
  // "disattivato" non trapela a chi non conosce la password (anti-enumerazione)
  // e i tempi non distinguono i casi.
  if (!verificaPassword(password, cred.hashPassword)) {
    const bloccato = await registraTentativoFallito(op._id);
    return bloccato
      ? { ok: false, motivo: "bloccato", minutiBlocco: BLOCCO_MINUTI }
      : { ok: false, motivo: "credenziali" };
  }

  // Password giusta ma account disattivato: lo si dice solo ora.
  if (!op.attivo) return { ok: false, motivo: "disattivato" };

  // Azzera i contatori.
  if (cred.tentativiFalliti || cred.bloccatoFinoA) {
    await (await credenziali()).updateOne(
      { _id: op._id },
      { $set: { tentativiFalliti: 0, bloccatoFinoA: null, aggiornataIl: new Date() } },
    );
  }
  return { ok: true, operatoreId: op._id, nome: op.nome };
}
