// Configurazione PM2 per il server di produzione (PC-server in ufficio).
//
// Avvia l'app GIÀ COMPILATA (serve prima «npm run build») sulla porta 4000, la
// tiene sempre accesa e la riavvia da sola se crasha o al riavvio del PC.
//
// Uso (dopo aver installato PM2 con «npm i -g pm2»):
//   npm run build
//   pm2 start ecosystem.config.js
//   pm2 save
//
// Nota Windows: si lancia il binario di Next con node (script sotto), NON «npm»,
// perché PM2 su Windows a volte non trova npm.cmd. Il risultato è identico a
// «npm run start».
module.exports = {
  apps: [
    {
      name: "galdieri",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 4000",
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: "production" },
    },
    {
      // Il report giornaliero (scripts/report-giornaliero.ts): manda la mail
      // agli admin con le recensioni gestite dalle 9:00 alle 18:00.
      //
      // NON è un processo che resta acceso: gira, manda la mail (o si ferma da
      // sé se l'ha già mandata oggi), esce. `autorestart:false` impedisce a PM2
      // di rilanciarlo in loop appena finisce; `cron_restart` lo fa ripartire
      // ogni giorno da solo, all'orario scritto lì (formato cron standard,
      // nell'ora del sistema — su questo PC è l'ora italiana).
      //
      // Avvio la PRIMA volta (non tocca l'app "galdieri" già accesa):
      //   pm2 start ecosystem.config.js --only galdieri-report
      //   pm2 save
      //
      // Prova a mano, subito, senza aspettare le 18:00:
      //   npx tsx scripts/report-giornaliero.ts
      // Il vero file JS di tsx, non lo shim node_modules/.bin/tsx(.cmd): PM2 su
      // Windows può avere difficoltà a lanciare un .cmd, esattamente come per
      // npm.cmd (vedi nota sopra su "galdieri"). Stesso trucco, stesso motivo.
      name: "galdieri-report",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "--tsconfig tsconfig.json scripts/report-giornaliero.ts",
      autorestart: false,
      cron_restart: "0 18 * * *",
      env: { NODE_ENV: "production" },
    },
  ],
};
