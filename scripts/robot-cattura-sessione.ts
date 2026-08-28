import { mkdirSync } from "fs";
import { apriContesto, PROFILO_DIR, sessioneAttiva } from "@/server/robot/google";

// Cattura della sessione Google per il robot.
//
// DA ESEGUIRE TU, nel tuo terminale (serve una finestra vera del browser):
//   npm run robot:sessione
//
// Si apre Chrome col profilo del robot: fai il login a Google (email, password,
// 2FA) e quando sei dentro premi INVIO. Il login resta salvato nel profilo
// (sotto data/, ignorato da git): il robot lo riuserà senza rifare l'accesso.

(async () => {
  mkdirSync(PROFILO_DIR, { recursive: true });
  console.log("Apro Chrome col profilo del robot…");
  const ctx = await apriContesto(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://business.google.com/").catch(() => {});

  console.log("\n>>> Fai il LOGIN a Google in questa finestra (email, password, 2FA).");
  console.log(">>> Quando sei DENTRO e vedi le recensioni, torna qui e premi INVIO.\n");
  await new Promise<void>((ok) => process.stdin.once("data", () => ok()));

  const attiva = await sessioneAttiva(page).catch(() => false);
  await ctx.close();
  console.log(
    attiva
      ? `\nSessione salvata in ${PROFILO_DIR}  ✓`
      : "\nAttenzione: sembra ancora sulla pagina di login. Rilancia e completa l'accesso.",
  );
  process.exit(0);
})().catch((e) => {
  console.error("\nERRORE:", e instanceof Error ? e.message : e);
  console.error("Se dice che Chrome non è installato: installa Google Chrome, oppure togliamo il canale 'chrome'.");
  process.exit(1);
});
