// Punto di avvio unico di Next: register() gira una volta per processo, prima
// che arrivi qualunque richiesta. È qui che si prepara il database, invece di
// farlo partire per effetto collaterale dal fondo di una loadSettings().
//
// L'import sta DENTRO il controllo su NEXT_RUNTIME, non dopo un early-return:
// è la forma che il compilatore di Next riconosce per eliminare il ramo nel
// bundle edge, dove i moduli node: (crypto, sqlite) non esistono e romperebbero
// la compilazione.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { avvia } = await import("@/server/db/avvio");
    try {
      await avvia();
    } catch (e) {
      // L'avvio riproverà alla prima operazione: non impedire a Next di partire.
      console.error("[instrumentation] avvio database rimandato:", e);
    }

    // Il pilota automatico parte SOLO dove è chiesto esplicitamente
    // (AUTOPILOTA=1 nel .env del PC-server). Il database è condiviso: senza
    // questo interruttore partirebbe anche su ogni portatile che avvia il
    // portale, e il robot aprirebbe Chrome sul PC sbagliato. Mai durante la
    // build: lì non c'è un server da tenere acceso.
    if (process.env.AUTOPILOTA === "1" && process.env.NEXT_PHASE !== "phase-production-build") {
      const { avviaPilota } = await import("@/server/automation/pilota");
      avviaPilota();
    }
  }
}
