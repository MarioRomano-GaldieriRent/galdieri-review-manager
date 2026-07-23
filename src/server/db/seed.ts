import type { AnyBulkWriteOperation, Db } from "mongodb";
import type { DocGen } from "./connessione";
import {
  AGENTE_ESCALATION,
  AGENTE_MARKETING,
  EMAIL_ESCALATION,
  EMAIL_TICKETING,
} from "@/server/automation/rules";
import { sediConosciute } from "@/server/automation/sedi";
import { CATALOGO } from "@/server/automation/types";

// Semina delle collezioni di riferimento, rieseguita a ogni avvio.
//
// La fonte di verità resta il TypeScript: il catalogo dei nodi vive in
// automation/types.ts, le sedi in automation/sedi.ts (ricavate dai ticket
// reali). Il database le insegue. Tutto è idempotente (upsert): rigirarla a
// ogni avvio è ciò che tiene il database allineato al codice quando si aggiunge
// una sede o un tipo di nodo, e ricrea l'operatore di sistema se sparisce.

/** Chiave normalizzata di una sede: minuscolo, spazi compressi. RESTA SINCRONA. */
export function normalizzaSede(sede: string): string {
  return sede.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Elenco chiuso delle impostazioni note. RESTA SINCRONO: è pura logica, e da qui
 * lo importa anche schema.ts per generare i validator sui segreti.
 *
 * `segreto: true` significa che il valore non viene mai scritto nel database —
 * lo impedisce un validator, non la buona volontà del codice. Non si deduce mai
 * da una regex sul nome: il giorno che nasce "apiKeyPubblica" sbaglierebbe.
 */
export const CATALOGO_IMPOSTAZIONI: {
  chiave: string;
  etichetta: string;
  segreto: boolean;
  env?: string;
}[] = [
  { chiave: "mailbox", etichetta: "Casella da leggere", segreto: false, env: "MAIL_WATCH_ADDRESS" },
  { chiave: "modo", etichetta: "Modalità operativa", segreto: false },
  { chiave: "graph.tenantId", etichetta: "Tenant Microsoft", segreto: false, env: "MICROSOFT_TENANT_ID" },
  { chiave: "graph.clientId", etichetta: "Client id Microsoft", segreto: false, env: "MICROSOFT_CLIENT_ID" },
  { chiave: "graph.clientSecret", etichetta: "Client secret Microsoft", segreto: true, env: "MICROSOFT_CLIENT_SECRET" },
  { chiave: "graph.graphUrl", etichetta: "Endpoint Graph", segreto: false, env: "GRAPH_API_URL" },
  { chiave: "translator.key", etichetta: "Chiave Azure Translator", segreto: true, env: "AZURE_TRANSLATOR_KEY" },
  { chiave: "translator.region", etichetta: "Regione Azure Translator", segreto: false, env: "AZURE_TRANSLATOR_REGION" },
  { chiave: "translator.endpoint", etichetta: "Endpoint Azure Translator", segreto: false, env: "AZURE_TRANSLATOR_ENDPOINT" },
  { chiave: "freshdesk.domain", etichetta: "Dominio Freshdesk", segreto: false, env: "FRESHDESK_DOMAIN" },
  { chiave: "freshdesk.apiKey", etichetta: "API key Freshdesk", segreto: true, env: "FRESHDESK_API_KEY" },
  { chiave: "googleReviews.clientId", etichetta: "Client id Google", segreto: false, env: "GOOGLE_CLIENT_ID" },
  { chiave: "googleReviews.clientSecret", etichetta: "Client secret Google", segreto: true, env: "GOOGLE_CLIENT_SECRET" },
  { chiave: "googleReviews.refreshToken", etichetta: "Refresh token Google", segreto: true, env: "GOOGLE_REFRESH_TOKEN" },
  { chiave: "googleReviews.accountId", etichetta: "Account Google Business", segreto: false, env: "GOOGLE_ACCOUNT_ID" },
  { chiave: "automation.emailEscalation", etichetta: "Casella per le negative", segreto: false },
  { chiave: "automation.testoEscalation", etichetta: "Testo di accompagnamento", segreto: false },
  { chiave: "automation.agenteMarketing", etichetta: "Agente Marketing", segreto: false },
  { chiave: "automation.agenteEscalation", etichetta: "Agente escalation", segreto: false },
  { chiave: "automation.tipoTicketGoogle", etichetta: "Tipo ticket recensioni", segreto: false },
];

/** Vero se la chiave è un segreto e quindi non va mai scritta nel database. RESTA SINCRONA. */
export function eSegreta(chiave: string): boolean {
  return CATALOGO_IMPOSTAZIONI.some((c) => c.chiave === chiave && c.segreto);
}

const LINGUE: [string, string, boolean][] = [
  ["it", "italiano", true],
  ["en", "inglese", false],
  ["de", "tedesco", false],
  ["fr", "francese", false],
  ["es", "spagnolo", false],
  ["pt", "portoghese", false],
  ["nl", "olandese", false],
  ["pl", "polacco", false],
  ["ro", "rumeno", false],
  ["hu", "ungherese", false],
  ["ru", "russo", false],
  ["cs", "ceco", false],
  ["sv", "svedese", false],
  ["da", "danese", false],
  ["no", "norvegese", false],
  ["fi", "finlandese", false],
  ["el", "greco", false],
  ["tr", "turco", false],
  ["ar", "arabo", false],
  ["zh-Hans", "cinese", false],
  ["ja", "giapponese", false],
];

/** upsert di un lotto, ignorando quel che c'è già di uguale. */
async function upsert(d: Db, nome: string, ops: AnyBulkWriteOperation<DocGen>[]): Promise<void> {
  if (ops.length > 0) await d.collection<DocGen>(nome).bulkWrite(ops, { ordered: false });
}

export async function semina(d: Db): Promise<void> {
  const ora = new Date();

  await upsert(
    d,
    "tipi_azione",
    Object.entries(CATALOGO).map(([tipo, meta]) => ({
      updateOne: {
        filter: { _id: tipo },
        update: {
          $set: { servizio: meta.servizio, titolo: meta.titolo, scrittura: Boolean(meta.scrittura) },
        },
        upsert: true,
      },
    })) as AnyBulkWriteOperation<DocGen>[],
  );

  await upsert(
    d,
    "lingue",
    LINGUE.map(([codice, nome, italiana]) => ({
      updateOne: {
        filter: { _id: codice },
        update: { $set: { nome }, $setOnInsert: { italiana } },
        upsert: true,
      },
    })) as AnyBulkWriteOperation<DocGen>[],
  );

  // La sentinella "" e le sedi note. tagFreshdesk può cambiare: si aggiorna.
  const sedi: AnyBulkWriteOperation<DocGen>[] = [
    {
      updateOne: {
        filter: { _id: "" },
        update: {
          $set: { nome: "(sede non riconosciuta)", tagFreshdesk: "" },
          $setOnInsert: { creataIl: new Date("1970-01-01T00:00:00.000Z") },
        },
        upsert: true,
      },
    },
    ...sediConosciute().map(({ sede, tag }) => ({
      updateOne: {
        filter: { _id: normalizzaSede(sede) },
        update: { $set: { nome: sede, tagFreshdesk: tag }, $setOnInsert: { creataIl: ora } },
        upsert: true,
      },
    })),
  ] as AnyBulkWriteOperation<DocGen>[];
  await upsert(d, "sedi", sedi);

  await upsert(
    d,
    "impostazioni_catalogo",
    CATALOGO_IMPOSTAZIONI.map((v) => ({
      updateOne: {
        filter: { _id: v.chiave },
        update: { $set: { etichetta: v.etichetta, segreto: v.segreto, variabileEnv: v.env ?? "" } },
        upsert: true,
      },
    })) as AnyBulkWriteOperation<DocGen>[],
  );

  // Operatore di sistema, id 1, default di ogni attribuzione. $setOnInsert: se
  // qualcuno lo cancella, il prossimo avvio lo ricrea (§ garanzie perse).
  await d.collection<DocGen>("operatori").updateOne(
    { _id: 1 },
    {
      $setOnInsert: {
        chiave: "sistema",
        nome: "Sistema",
        email: null,
        tipo: "sistema",
        ruolo: "operatore implicito",
        attivo: true,
        diSistema: true,
        creatoIl: new Date("1970-01-01T00:00:00.000Z"),
        disattivatoIl: null,
      },
    },
    { upsert: true },
  );

  await upsert(d, "agenti_freshdesk", [
    {
      updateOne: {
        filter: { _id: AGENTE_MARKETING },
        update: {
          $set: { nome: "Ufficio Marketing", gruppo: "Customer Care", aggiornatoIl: ora },
          $setOnInsert: { email: null, attivo: true, operatoreId: null },
        },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { _id: AGENTE_ESCALATION },
        update: {
          $set: { nome: "Cherubina Panico", email: EMAIL_ESCALATION, gruppo: "Customer Care", aggiornatoIl: ora },
          $setOnInsert: { attivo: true, operatoreId: null },
        },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { _id: "80000162477" },
        update: {
          $set: { nome: "Customer Care", email: EMAIL_TICKETING, gruppo: "Customer Care", aggiornatoIl: ora },
          $setOnInsert: { attivo: true, operatoreId: null },
        },
        upsert: true,
      },
    },
  ] as AnyBulkWriteOperation<DocGen>[]);
}
