import type { DatabaseSync } from "node:sqlite";
import {
  AGENTE_ESCALATION,
  AGENTE_MARKETING,
  EMAIL_ESCALATION,
  EMAIL_TICKETING,
} from "@/server/automation/rules";
import { sediConosciute } from "@/server/automation/sedi";
import { CATALOGO } from "@/server/automation/types";
import { adesso } from "@/server/tempo";

// Semina delle tabelle di riferimento, rieseguita a ogni apertura.
//
// La fonte di verità resta il TypeScript: il catalogo dei nodi vive in
// automation/types.ts, le sedi in automation/sedi.ts (ricavate dai ticket
// reali). Il database le insegue, non le sostituisce — così aggiungere una
// sede resta una riga di codice, e non un intervento sul database.
//
// Tutto è idempotente: ON CONFLICT DO UPDATE dove il valore può cambiare,
// DO NOTHING dove la riga è di sola presenza.

/** Chiave normalizzata di una sede: minuscolo, spazi compressi. */
export function normalizzaSede(sede: string): string {
  return sede.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Elenco chiuso delle impostazioni note.
 *
 * `segreto: true` significa che il valore NON viene mai scritto nel database:
 * lo impedisce un trigger, non la buona volontà di chi scrive il codice. Il
 * valore vero si legge dal .env (o da data/segreti.json se digitato dal
 * pannello), esattamente come già fa pick() in settings.ts.
 *
 * Non si deduce mai da una regex sul nome del campo: il giorno che nasce
 * "apiKeyPubblica" la regex sbaglia, e sbaglia in silenzio.
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

/** Vero se la chiave è un segreto e quindi non va mai scritta nel database. */
export function eSegreta(chiave: string): boolean {
  return CATALOGO_IMPOSTAZIONI.some((c) => c.chiave === chiave && c.segreto);
}

// Lingue che compaiono davvero nelle recensioni ricevute, più le principali
// europee. L'elenco non è chiuso: salvaRecensioni aggiunge quelle nuove.
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

export function semina(c: DatabaseSync): void {
  const ora = adesso();

  // ---- tipi di nodo: il catalogo del codice è la verità -------------------
  const insTipo = c.prepare(
    `INSERT INTO tipi_azione (tipo, servizio, titolo, scrittura) VALUES (?,?,?,?)
     ON CONFLICT(tipo) DO UPDATE SET
       servizio = excluded.servizio, titolo = excluded.titolo, scrittura = excluded.scrittura`,
  );
  for (const [tipo, meta] of Object.entries(CATALOGO)) {
    insTipo.run(tipo, meta.servizio, meta.titolo, meta.scrittura ? 1 : 0);
  }

  // ---- lingue -------------------------------------------------------------
  const insLingua = c.prepare(
    `INSERT INTO lingue (codice, nome, italiana) VALUES (?,?,?) ON CONFLICT(codice) DO NOTHING`,
  );
  for (const [codice, nome, italiana] of LINGUE) insLingua.run(codice, nome, italiana ? 1 : 0);

  // ---- sedi ---------------------------------------------------------------
  const insSede = c.prepare(
    `INSERT INTO sedi (nome, nome_normalizzato, tag_freshdesk, creata_il) VALUES (?,?,?,?)
     ON CONFLICT(nome_normalizzato) DO UPDATE SET tag_freshdesk = excluded.tag_freshdesk`,
  );
  for (const { sede, tag } of sediConosciute()) {
    insSede.run(sede, normalizzaSede(sede), tag, ora);
  }

  // ---- catalogo impostazioni ---------------------------------------------
  const insCat = c.prepare(
    `INSERT INTO impostazioni_catalogo (chiave, etichetta, segreto, variabile_env) VALUES (?,?,?,?)
     ON CONFLICT(chiave) DO UPDATE SET
       etichetta = excluded.etichetta, segreto = excluded.segreto,
       variabile_env = excluded.variabile_env`,
  );
  for (const v of CATALOGO_IMPOSTAZIONI) {
    insCat.run(v.chiave, v.etichetta, v.segreto ? 1 : 0, v.env ?? "");
  }

  // ---- agenti Freshdesk ---------------------------------------------------
  // Identità di un altro sistema, non persone di questa applicazione: il
  // collegamento a un operatore resta vuoto finché non serve.
  const insAgente = c.prepare(
    `INSERT INTO agenti_freshdesk (id_freshdesk, nome, email, gruppo, aggiornato_il) VALUES (?,?,?,?,?)
     ON CONFLICT(id_freshdesk) DO UPDATE SET nome = excluded.nome, gruppo = excluded.gruppo`,
  );
  insAgente.run(AGENTE_MARKETING, "Ufficio Marketing", null, "Customer Care", ora);
  insAgente.run(AGENTE_ESCALATION, "Cherubina Panico", EMAIL_ESCALATION, "Customer Care", ora);
  insAgente.run("80000162477", "Customer Care", EMAIL_TICKETING, "Customer Care", ora);
}
