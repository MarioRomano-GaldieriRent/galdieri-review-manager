import { coll } from "@/server/db/connessione";
import { OPERATORE_SISTEMA, registraAttivita } from "@/server/db/attivita";
import {
  cifra,
  decifra,
  generaCodiciRecupero,
  generaSegretoTotp,
  hashCodiceRecupero,
  hashPassword,
  passoTotpValido,
  verificaPassword,
} from "./crypto";

// ---------------------------------------------------------------------------
// Utenti e credenziali. Un "utente" è un operatore di tipo "persona" (collezione
// operatori, già esistente) con una riga di credenziali collegata per _id. Il
// profilo e i segreti restano in due collezioni diverse: qui si toccano insieme
// solo dove serve, e il resto dell'app continua a vedere solo operatori.
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

interface CodiceRecupero {
  hash: string;
  usato: boolean;
  usatoIl?: Date | null;
}

interface CredenzialeDoc {
  _id: number;
  hashPassword: string;
  totpCifrato: string | null;
  totpAttivo: boolean;
  codiciRecupero?: CodiceRecupero[];
  tentativiFalliti: number;
  tentativiTotp?: number;
  bloccatoFinoA: Date | null;
  ultimoPassoTotp?: number;
  creataIl: Date;
  aggiornataIl: Date;
}

// Difesa forza bruta: dopo troppi tentativi falliti consecutivi, blocco a tempo.
// Il TOTP ha una soglia più alta perché le cifre si sbagliano più facilmente;
// il blocco (bloccatoFinoA) è condiviso e ferma entrambi i fattori.
const MAX_TENTATIVI = 5;
const MAX_TENTATIVI_TOTP = 8;
const BLOCCO_MINUTI = 15;
const BLOCCO_MS = BLOCCO_MINUTI * 60000;

/**
 * Incremento ATOMICO del contatore di tentativi (campo indicato) e blocco a
 * tempo quando supera la soglia: findOneAndUpdate con pipeline, così N richieste
 * concorrenti non azzerano il lockout (niente read-modify-write). Ritorna true
 * se, dopo questo tentativo, l'account risulta bloccato.
 */
async function registraTentativoFallito(
  operatoreId: number,
  campo: "tentativiFalliti" | "tentativiTotp",
  soglia: number,
): Promise<boolean> {
  const r = (await (
    await credenziali()
  ).findOneAndUpdate(
    { _id: operatoreId },
    [
      { $set: { _n: { $add: [{ $ifNull: [`$${campo}`, 0] }, 1] } } },
      {
        $set: {
          bloccatoFinoA: {
            $cond: [{ $gte: ["$_n", soglia] }, { $add: ["$$NOW", BLOCCO_MS] }, "$bloccatoFinoA"],
          },
          [campo]: { $cond: [{ $gte: ["$_n", soglia] }, 0, "$_n"] },
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
export async function elencoUtenti(): Promise<
  (OperatoreDoc & { totpAttivo: boolean; haCredenziali: boolean })[]
> {
  const ops = (await (await operatori())
    .find({ tipo: "persona" })
    .sort({ attivo: -1, nome: 1 })
    .toArray()) as unknown as OperatoreDoc[];
  const creds = (await (await credenziali()).find({}).toArray()) as unknown as CredenzialeDoc[];
  const perId = new Map(creds.map((c) => [c._id, c]));
  return ops.map((o) => ({
    ...o,
    haCredenziali: perId.has(o._id),
    totpAttivo: Boolean(perId.get(o._id)?.totpAttivo),
  }));
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
  if (dati.password.length < 10)
    throw new Error("La password deve avere almeno 10 caratteri.");
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
    totpCifrato: null,
    totpAttivo: false,
    codiciRecupero: [],
    tentativiFalliti: 0,
    tentativiTotp: 0,
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
    { $set: { hashPassword: hashPassword(nuova), tentativiFalliti: 0, bloccatoFinoA: null, aggiornataIl: new Date() } },
  );
  await registraAttivita("utente.password_cambiata", {
    operatoreId: da,
    oggettoTipo: "operatore",
    oggettoId: String(operatoreId),
  });
}

// --------------------------------------------------- primo fattore (password)

export type EsitoAccesso =
  | { ok: true; operatoreId: number; nome: string; totpAttivo: boolean }
  | { ok: false; motivo: "credenziali" | "bloccato" | "disattivato"; minutiBlocco?: number };

/**
 * Verifica username + password (primo fattore). Applica il lockout e non svela
 * se lo username esista: quando manca, esegue comunque un confronto fittizio,
 * così la durata della risposta non distingue "utente inesistente" da "password
 * sbagliata".
 */
export async function verificaAccesso(chiaveGrezza: string, password: string): Promise<EsitoAccesso> {
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
    const bloccato = await registraTentativoFallito(op._id, "tentativiFalliti", MAX_TENTATIVI);
    return bloccato
      ? { ok: false, motivo: "bloccato", minutiBlocco: BLOCCO_MINUTI }
      : { ok: false, motivo: "credenziali" };
  }

  // Password giusta ma account disattivato: lo si dice solo ora.
  if (!op.attivo) return { ok: false, motivo: "disattivato" };

  // Azzera i contatori (di entrambi i fattori).
  if (cred.tentativiFalliti || cred.tentativiTotp || cred.bloccatoFinoA) {
    await (await credenziali()).updateOne(
      { _id: op._id },
      { $set: { tentativiFalliti: 0, tentativiTotp: 0, bloccatoFinoA: null, aggiornataIl: new Date() } },
    );
  }
  return { ok: true, operatoreId: op._id, nome: op.nome, totpAttivo: cred.totpAttivo };
}

// --------------------------------------------------- secondo fattore (TOTP)

/** true se l'utente ha già attivato il TOTP. */
export async function totpAttivo(operatoreId: number): Promise<boolean> {
  const cred = await leggiCredenziale(operatoreId);
  return Boolean(cred?.totpAttivo);
}

/**
 * Verifica il secondo fattore: prima come codice TOTP, poi come codice di
 * recupero (che, se valido, viene consumato). Ritorna anche se era un recupero,
 * per poter avvisare l'utente che gliene resta uno in meno.
 */
export async function verificaSecondoFattore(
  operatoreId: number,
  codice: string,
): Promise<{ ok: boolean; recupero?: boolean; recuperiRimasti?: number; bloccato?: boolean }> {
  const cred = await leggiCredenziale(operatoreId);
  if (!cred || !cred.totpAttivo) return { ok: false };

  // Blocco attivo (troppi tentativi su un fattore o sull'altro).
  if (cred.bloccatoFinoA && new Date(cred.bloccatoFinoA).getTime() > Date.now()) {
    return { ok: false, bloccato: true };
  }

  // 1) TOTP, con anti-replay: un codice vale una volta sola (passo > ultimo).
  if (cred.totpCifrato) {
    let segreto: string | null = null;
    try {
      segreto = decifra(cred.totpCifrato);
    } catch {
      // Chiave AES persa/ruotata: si prosegue coi codici di recupero, che non
      // dipendono da AUTH_ENC_KEY.
      segreto = null;
    }
    if (segreto) {
      const passo = passoTotpValido(segreto, codice);
      if (passo !== null) {
        if (passo <= (cred.ultimoPassoTotp ?? 0)) {
          // Codice giusto ma già consumato: replay, si rifiuta senza contare il
          // tentativo (non è un tiro alla cieca).
          return { ok: false };
        }
        await (await credenziali()).updateOne(
          { _id: operatoreId },
          {
            $set: {
              ultimoPassoTotp: passo,
              tentativiTotp: 0,
              tentativiFalliti: 0,
              bloccatoFinoA: null,
              aggiornataIl: new Date(),
            },
          },
        );
        return { ok: true };
      }
    }
  }

  // 2) Codice di recupero (a uso singolo).
  const hash = hashCodiceRecupero(codice);
  const codici = cred.codiciRecupero ?? [];
  const idx = codici.findIndex((c) => c.hash === hash && !c.usato);
  if (idx >= 0) {
    codici[idx] = { ...codici[idx], usato: true, usatoIl: new Date() };
    await (await credenziali()).updateOne(
      { _id: operatoreId },
      {
        $set: {
          codiciRecupero: codici,
          tentativiTotp: 0,
          tentativiFalliti: 0,
          bloccatoFinoA: null,
          aggiornataIl: new Date(),
        },
      },
    );
    await registraAttivita("utente.recupero_usato", {
      operatoreId,
      oggettoTipo: "operatore",
      oggettoId: String(operatoreId),
    });
    return { ok: true, recupero: true, recuperiRimasti: codici.filter((c) => !c.usato).length };
  }

  // 3) Fallimento: contatore atomico del secondo fattore, con blocco a soglia.
  const bloccato = await registraTentativoFallito(operatoreId, "tentativiTotp", MAX_TENTATIVI_TOTP);
  return { ok: false, bloccato };
}

// ------------------------------------------------- enrollment (attivazione TOTP)

/**
 * Prepara un nuovo secret TOTP e lo salva cifrato, SENZA ancora attivarlo: il
 * TOTP diventa obbligatorio solo dopo che l'utente ha confermato un codice, così
 * un enrollment interrotto non lo chiude fuori. Ritorna il secret in chiaro solo
 * per costruire il QR in questa richiesta.
 */
export async function preparaTotp(operatoreId: number): Promise<string> {
  const segreto = generaSegretoTotp();
  await (await credenziali()).updateOne(
    { _id: operatoreId },
    { $set: { totpCifrato: cifra(segreto), totpAttivo: false, aggiornataIl: new Date() } },
  );
  return segreto;
}

/** Il secret in preparazione (per rigenerare il QR senza cambiarlo a ogni refresh). */
export async function segretoTotpInCorso(operatoreId: number): Promise<string | null> {
  const cred = await leggiCredenziale(operatoreId);
  if (!cred?.totpCifrato) return null;
  try {
    return decifra(cred.totpCifrato);
  } catch {
    return null;
  }
}

/**
 * Conferma l'attivazione TOTP verificando un primo codice. Al successo genera i
 * codici di recupero (mostrati una sola volta) e attiva il secondo fattore.
 */
export async function confermaTotp(
  operatoreId: number,
  codice: string,
): Promise<{ ok: boolean; codiciRecupero?: string[] }> {
  const segreto = await segretoTotpInCorso(operatoreId);
  const passo = segreto ? passoTotpValido(segreto, codice) : null;
  if (passo === null) return { ok: false };

  const codici = generaCodiciRecupero(10);
  const hashed = codici.map((c) => ({ hash: hashCodiceRecupero(c), usato: false, usatoIl: null }));
  await (await credenziali()).updateOne(
    { _id: operatoreId },
    {
      $set: {
        totpAttivo: true,
        codiciRecupero: hashed,
        // Segna subito come consumato il passo dell'attivazione: non potrà essere
        // riusato al primo login.
        ultimoPassoTotp: passo,
        tentativiFalliti: 0,
        tentativiTotp: 0,
        bloccatoFinoA: null,
        aggiornataIl: new Date(),
      },
    },
  );
  await registraAttivita("utente.totp_attivato", {
    operatoreId,
    oggettoTipo: "operatore",
    oggettoId: String(operatoreId),
  });
  return { ok: true, codiciRecupero: codici };
}

/** Azzera il TOTP di un utente (lo dovrà riattivare al prossimo accesso). */
export async function azzeraTotp(operatoreId: number, da = OPERATORE_SISTEMA): Promise<void> {
  await (await credenziali()).updateOne(
    { _id: operatoreId },
    { $set: { totpCifrato: null, totpAttivo: false, codiciRecupero: [], aggiornataIl: new Date() } },
  );
  await registraAttivita("utente.totp_azzerato", {
    operatoreId: da,
    oggettoTipo: "operatore",
    oggettoId: String(operatoreId),
  });
}
