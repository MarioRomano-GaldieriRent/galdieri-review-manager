# Galdieri rent — Posta in arrivo

App minimale che mostra **tutte le email in arrivo** su una casella Microsoft 365 — fra cui le notifiche di nuove recensioni Google/Trustpilot inoltrate da Zapier.

- **Nessun login, nessun database**: apri e vedi la posta
- Lettura via **Microsoft Graph** in modalità *app-only* (client credentials)
- Ricerca full-text e paginazione; le email con "recension*" nell'oggetto sono evidenziate

## Requisiti

- **Node.js ≥ 20**
- Una **app registration Azure** con permessi **applicativi** `Mail.Read` su Microsoft Graph

## Avvio

```bash
npm install
cp .env.example .env     # poi compila i valori
npm run dev              # http://localhost:3000
```

## Configurazione (`.env`)

| Variabile | Descrizione |
|---|---|
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_SECRET` | App registration Azure |
| `MAIL_WATCH_ADDRESS` | Casella da mostrare (qualsiasi casella del tenant) |

> I segreti stanno **solo** in `.env` (git-ignorato). Non committarli mai.

## Verifica del collegamento a Microsoft

```bash
npm run test:graph
```

Stampa se il token viene ottenuto, quali permessi ha l'app e le ultime email della casella.

## Struttura

```
src/app/page.tsx            Posta in arrivo (unica pagina)
src/app/layout.tsx          Header con il marchio
src/app/globals.css         Stile
src/server/graph/client.ts  Client Microsoft Graph (token cache + lettura Inbox)
scripts/test-graph.ts       Diagnostica del collegamento
```
