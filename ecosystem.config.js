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
  ],
};
