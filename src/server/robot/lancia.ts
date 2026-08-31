import { spawn } from "node:child_process";

// Avvia il robot "usa e getta" (scripts/robot-esegui.ts) come processo figlio e
// ne aspetta l'esito. Il lavoro viaggia nell'env ROBOT_JOB (niente argomenti da
// far mangiare a PowerShell), l'esito torna nella riga  __ESITO__ {json}  che il
// runner stampa. È un'operazione LENTA (apre un browser): chi la chiama sa che
// blocca finché il robot non ha finito.

export type JobRobot = { azione: "test" | "pubblica" | "cerca"; nome: string; testo: string };

export type EsitoRobot = {
  ok: boolean;
  stato: string;
  messaggio: string;
  gruppo?: string;
  trovata?: boolean;
  scritto?: boolean;
};

/**
 * Avvia il robot e NON aspetta: apre il browser e lo lascia in mano
 * all'operatore (usato dal tasto "G" con azione "cerca"). Processo sganciato,
 * così l'azione del server torna subito e la finestra resta aperta da sola.
 */
export function avviaRobotSganciato(job: JobRobot): void {
  const child = spawn("npm run --silent robot:esegui", {
    cwd: process.cwd(),
    env: { ...process.env, ROBOT_JOB: JSON.stringify(job) },
    shell: true,
    windowsHide: false,
    detached: true,
    stdio: "ignore",
  });
  child.unref(); // scollega il figlio: vive per conto suo, non blocca il server
}

/**
 * Avvia il robot in modalità "cerca" e aspetta SOLO il primo esito (trovata /
 * non trovata), che il runner stampa appena finita la ricerca — poi SGANCIA il
 * processo e lascia la finestra aperta per conto suo. Così il front può mostrare
 * "sto cercando…" e poi l'esito in pochi secondi, mentre la finestra resta lì
 * per l'operatore. Se entro `attesaMs` non arriva niente, torna un esito di
 * attesa (la finestra potrebbe essersi aperta lo stesso).
 */
export function avviaRobotConEsito(
  job: JobRobot,
  { attesaMs = 150_000 }: { attesaMs?: number } = {},
): Promise<EsitoRobot> {
  return new Promise((resolve) => {
    const child = spawn("npm run --silent robot:esegui", {
      cwd: process.cwd(),
      env: { ...process.env, ROBOT_JOB: JSON.stringify(job) },
      shell: true,
      windowsHide: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let risolto = false;
    const unref = (s: unknown) => {
      try {
        (s as { unref?: () => void })?.unref?.();
      } catch {
        /* niente */
      }
    };

    const finisci = (e: EsitoRobot) => {
      if (risolto) return;
      risolto = true;
      clearTimeout(timer);
      // Molla il processo: la finestra del robot resta aperta da sola, il server
      // non aspetta più. `resume` svuota il buffer così il figlio non si blocca.
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.resume();
      child.stderr?.resume();
      unref(child.stdout);
      unref(child.stderr);
      child.unref();
      resolve(e);
    };

    const guarda = (d: Buffer) => {
      out += d.toString();
      const righe = out.split(/\r?\n/).filter((r) => r.includes("__ESITO__"));
      const ultima = righe[righe.length - 1];
      if (!ultima) return;
      const m = ultima.match(/__ESITO__\s+(\{.*\})/);
      if (!m) return;
      try {
        finisci(JSON.parse(m[1]) as EsitoRobot);
      } catch {
        /* riga incompleta: aspetto la prossima */
      }
    };

    child.stdout?.on("data", guarda);
    child.stderr?.on("data", guarda);
    child.on("error", (e) =>
      finisci({ ok: false, stato: "avvio-fallito", messaggio: `Non riesco ad avviare il robot: ${e.message}` }),
    );
    child.on("close", () =>
      finisci({
        ok: false,
        stato: "senza-esito",
        messaggio: out.trim().slice(-240) || "Il robot è terminato senza dare un esito.",
      }),
    );

    const timer = setTimeout(
      () =>
        finisci({
          ok: false,
          stato: "attesa",
          messaggio:
            "Il robot ci sta mettendo più del previsto. La finestra potrebbe essersi aperta lo stesso sul server: controllala.",
        }),
      attesaMs,
    );
  });
}

export async function lanciaRobot(job: JobRobot): Promise<EsitoRobot> {
  return new Promise((resolve) => {
    // shell:true → funziona sia con npm.cmd su Windows sia con npm su unix;
    // il comando è FISSO e il job passa dall'ambiente, quindi niente iniezione.
    const child = spawn("npm run --silent robot:esegui", {
      cwd: process.cwd(),
      env: { ...process.env, ROBOT_JOB: JSON.stringify(job) },
      shell: true,
      windowsHide: false, // la finestra del browser dev'essere visibile
    });

    let out = "";
    let risolto = false;
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));

    // Rete di sicurezza: se il robot resta appeso, lo chiudo dopo 3 minuti.
    const timeout = setTimeout(
      () => {
        try {
          child.kill();
        } catch {
          /* già morto */
        }
        if (!risolto) {
          risolto = true;
          resolve({ ok: false, stato: "timeout", messaggio: "Il robot ci ha messo troppo: l'ho fermato. Riprova (browser chiuso, Chrome chiuso)." });
        }
      },
      3 * 60 * 1000,
    );

    const chiudi = (fallback: EsitoRobot) => {
      if (risolto) return;
      risolto = true;
      clearTimeout(timeout);
      const righe = out.split(/\r?\n/).filter((r) => r.includes("__ESITO__"));
      const ultima = righe[righe.length - 1];
      if (ultima) {
        const m = ultima.match(/__ESITO__\s+(\{.*\})/);
        if (m) {
          try {
            resolve(JSON.parse(m[1]) as EsitoRobot);
            return;
          } catch {
            /* cade sul fallback */
          }
        }
      }
      resolve(fallback);
    };

    child.on("close", (code) =>
      chiudi({
        ok: false,
        stato: "senza-esito",
        messaggio: out.trim().slice(-300) || `Robot terminato (codice ${code}) senza esito leggibile.`,
      }),
    );
    child.on("error", (e) =>
      chiudi({ ok: false, stato: "avvio-fallito", messaggio: `Non riesco ad avviare il robot: ${e.message}` }),
    );
  });
}
