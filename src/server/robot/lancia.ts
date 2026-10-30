import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

// Avvia il robot "usa e getta" (scripts/robot-esegui.ts) come processo figlio e
// ne aspetta l'esito. Il lavoro viaggia nell'env ROBOT_JOB (niente argomenti da
// far mangiare a PowerShell), l'esito torna nella riga  __ESITO__ {json}  che il
// runner stampa. È un'operazione LENTA (apre un browser): chi la chiama sa che
// blocca finché il robot non ha finito.

export type JobRobot = {
  // "prova-coda": METODO DI PROVA (solo admin, vedi provaCodaIgnoraAction) —
  // usa la coda «Rispondi alle recensioni» + «Ignora» invece di scorrere la
  // lista. NON pubblica MAI, qualunque cosa succeda: è un test.
  azione: "test" | "pubblica" | "cerca" | "prova-coda";
  nome: string;
  testo: string;
  /**
   * Nome dell'attività su Google della sede (dal «Mapping»), se mappata: il
   * robot va DRITTO su quella sede. Vuoto/assente = ripiego sui gruppi.
   */
  nomeGoogle?: string;
  /**
   * Il testo della recensione com'è nel database. Serve al metodo della coda
   * per riconoscere QUALE recensione sta guardando: i nomi si ripetono e a
   * volte sono una sola lettera, il testo no. Se manca si va di solo nome.
   */
  testoRecensione?: string;
  /**
   * Quale metodo di ricerca provare PER PRIMO sulla sede mappata. L'altro resta
   * come ripiego: nessuno dei due viene mai buttato via.
   *
   *   "coda"  → la coda «Rispondere a recensioni» + «Ignora» (default). È la
   *             strada giusta per le recensioni CON testo — quelle che arrivano
   *             dal customer care — perché la coda mostra solo le recensioni
   *             ancora senza risposta e le riconosce dal testo, che è una prova
   *             sicura anche quando l'autore si chiama «D».
   *   "lista" → la ricerca classica nella lista della sede. Serve per le 5★
   *             SECCHE, senza testo: lì la coda non avrebbe niente da
   *             confrontare e potrebbe fermarsi sull'omonimo sbagliato.
   */
  metodo?: "coda" | "lista";
};

export type EsitoRobot = {
  ok: boolean;
  stato: string;
  messaggio: string;
  gruppo?: string;
  trovata?: boolean;
  scritto?: boolean;
  /**
   * Passo-passo di quello che il robot ha fatto su Google. C'è in OGNI esito,
   * pubblicazione compresa (scripts/robot-esegui.ts lo allega sempre): è la
   * sola prova di che cosa ha visto davvero quando qualcosa non va.
   */
  log?: string[];
};

// -------------------------------------------------------------- un robot per volta
//
// Chrome usa un profilo a ISTANZA SINGOLA: due robot insieme si contenderebbero
// lo stesso browser (crash o dirottamento). Questo lucchetto in memoria impedisce
// il secondo avvio finché il primo non è finito (o l'operatore non ha chiuso la
// sua finestra). Node è a thread singolo e fra il controllo e lo spawn non c'è
// alcun await, quindi due click contemporanei NON possono passare entrambi. Vive
// nel processo del server: se il server riparte si azzera, ma resta la rete di
// sicurezza chromeInEsecuzione() dentro il robot.
let robotInUso = false;

function esitoOccupato(): EsitoRobot {
  return {
    ok: false,
    stato: "occupato",
    messaggio:
      "🤖 Il robot è già in uso: aspetta che finisca l'operazione in corso (o chiudi la sua finestra di Chrome sul server), poi riprova.",
  };
}

/** Segna il robot occupato finché il processo figlio non esce (finestra chiusa). */
function tieniOccupato(child: ChildProcess): void {
  robotInUso = true;
  child.once("exit", () => {
    robotInUso = false;
  });
}

/** true se un robot è in esecuzione adesso. */
export function robotOccupato(): boolean {
  return robotInUso;
}

/**
 * Avvia il robot e NON aspetta: apre il browser e lo lascia in mano
 * all'operatore (usato dal tasto "G" con azione "cerca"). Processo sganciato,
 * così l'azione del server torna subito e la finestra resta aperta da sola.
 */
// --- Il diario del robot, su file ------------------------------------------
//
// Il passo-passo viaggiava solo dentro l'output del processo figlio, e lì si
// perde in troppi modi: il robot ucciso allo scadere del tempo, l'output
// troncato passando da cmd e npm, il processo morto prima di stampare l'esito.
// Sulla card restava «il robot non è arrivato a raccontare niente» proprio
// quando il racconto serviva.
//
// Adesso il robot scrive ogni riga su un file, appena l'ha fatta
// (appendFileSync, nessun buffer): qui si decide il percorso, lo si passa al
// figlio con ROBOT_LOG_FILE e, se l'esito torna muto, lo si legge da lì. Il
// file resta anche dopo, per guardarci dentro con calma.

export const DIARIO_DIR = path.join(process.cwd(), "data", "robot-log");

/** Quanti diari si tengono: oltre questi si cancellano i più vecchi. */
const DIARI_TENUTI = 60;

function nuovoDiario(job: JobRobot): string {
  const quando = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const nome = `${quando}-${job.azione}.log`;
  try {
    mkdirSync(DIARIO_DIR, { recursive: true });
    const vecchi = readdirSync(DIARIO_DIR)
      .filter((f) => f.endsWith(".log"))
      .sort();
    for (const f of vecchi.slice(0, Math.max(0, vecchi.length - DIARI_TENUTI))) {
      try {
        unlinkSync(path.join(DIARIO_DIR, f));
      } catch {
        /* se non si cancella, pazienza */
      }
    }
  } catch {
    /* niente cartella: il robot scriverà solo su stdout, come prima */
  }
  return path.join(DIARIO_DIR, nome);
}

/** Le righe del diario su file, senza la riga dell'esito. Vuoto se il file non c'è. */
export function leggiDiario(file: string): string[] {
  if (!file) return [];
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((r) => r.trimEnd())
      .filter((r) => r !== "" && !r.startsWith("__ESITO__"))
      .slice(-80);
  } catch {
    return [];
  }
}

export function avviaRobotSganciato(job: JobRobot): void {
  if (robotInUso) return; // già occupato: non aprire un secondo Chrome
  const child = spawn("npm run --silent robot:esegui", {
    cwd: process.cwd(),
    env: { ...process.env, ROBOT_JOB: JSON.stringify(job), ROBOT_LOG_FILE: nuovoDiario(job) },
    shell: true,
    windowsHide: false,
    detached: true,
    stdio: "ignore",
  });
  tieniOccupato(child);
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
  if (robotInUso) return Promise.resolve(esitoOccupato());
  return new Promise((resolve) => {
    const fileDiario = nuovoDiario(job);
    const child = spawn("npm run --silent robot:esegui", {
      cwd: process.cwd(),
      env: { ...process.env, ROBOT_JOB: JSON.stringify(job), ROBOT_LOG_FILE: fileDiario },
      shell: true,
      windowsHide: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    tieniOccupato(child);

    let out = "";
    let risolto = false;
    const unref = (s: unknown) => {
      try {
        (s as { unref?: () => void })?.unref?.();
      } catch {
        /* niente */
      }
    };

    /**
     * I righi di traccia che il robot stampa su stderr ("   …"). Servono per
     * mostrare i passi ANCHE quando l'esito non arriva mai (tempo scaduto,
     * processo morto): prima in quei casi la card restava senza niente da
     * leggere e ogni tentativo sembrava identico al precedente.
     */
    const diario = (): string[] =>
      out
        .split(/\r?\n/)
        .filter((r) => /^ {3}\S/.test(r))
        .map((r) => r.slice(3))
        .slice(-60);

    const finisci = (e0: EsitoRobot) => {
      if (risolto) return;
      risolto = true;
      // Se l'esito arriva senza passo-passo — ucciso, troncato, morto prima di
      // stampare — lo si prende dal file, dove ogni riga è già sul disco. Il
      // file viene prima: è più completo dell'output raccolto qui.
      const daFile = leggiDiario(fileDiario);
      const e =
        e0.log && e0.log.length > 0 ? e0 : { ...e0, log: daFile.length > 0 ? daFile : diario() };
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
      finisci({
        ok: false,
        stato: "avvio-fallito",
        messaggio: `Non riesco ad avviare il robot: ${e.message}`,
      }),
    );
    child.on("close", () =>
      finisci({
        ok: false,
        stato: "senza-esito",
        messaggio: out.trim().slice(-240) || "Il robot è terminato senza dare un esito.",
        log: diario(),
      }),
    );

    const timer = setTimeout(
      () =>
        finisci({
          ok: false,
          stato: "attesa",
          messaggio:
            "Il robot ci sta mettendo più del previsto: qui sotto ci sono i passi fatti fino a ora. La finestra potrebbe essere ancora aperta sul server.",
          log: diario(),
        }),
      attesaMs,
    );
  });
}

/**
 * `attesaMs` è la rete di sicurezza: oltre quel tempo il robot viene ucciso.
 * Il default di 3 minuti bastava quando la coda aveva una scadenza corta; col
 * metodo della coda per primo (recensioni con testo) servono più minuti, e chi
 * chiama lo dice qui — il robot ha comunque una scadenza INTERNA più corta, così
 * torna da sé col passo-passo invece di farsi ammazzare senza dire niente.
 */
export async function lanciaRobot(
  job: JobRobot,
  { attesaMs = 3 * 60 * 1000 }: { attesaMs?: number } = {},
): Promise<EsitoRobot> {
  if (robotInUso) return esitoOccupato();
  return new Promise((resolve) => {
    // shell:true → funziona sia con npm.cmd su Windows sia con npm su unix;
    // il comando è FISSO e il job passa dall'ambiente, quindi niente iniezione.
    const fileDiario = nuovoDiario(job);
    const child = spawn("npm run --silent robot:esegui", {
      cwd: process.cwd(),
      env: { ...process.env, ROBOT_JOB: JSON.stringify(job), ROBOT_LOG_FILE: fileDiario },
      shell: true,
      windowsHide: false, // la finestra del browser dev'essere visibile
    });
    tieniOccupato(child);

    let out = "";
    let risolto = false;
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));

    /**
     * I righi di traccia del robot ("   …" su stderr). Servono a far vedere i
     * passi ANCHE quando l'esito non arriva mai — tempo scaduto o processo
     * ammazzato — che è proprio il caso in cui l'operatore non capisce cosa
     * sia successo. `avviaRobotConEsito` lo faceva già; qui mancava.
     */
    const diarioDiLancio = (): string[] =>
      out
        .split(/\r?\n/)
        .filter((r) => /^ {3}\S/.test(r))
        .map((r) => r.slice(3))
        .slice(-60);

    // Rete di sicurezza: se il robot resta appeso, lo chiudo (vedi `attesaMs`).
    const timeout = setTimeout(
      () => {
        try {
          child.kill();
        } catch {
          /* già morto */
        }
        if (!risolto) {
          risolto = true;
          // Ucciso a metà: il passo-passo è sul file, riga per riga, e questo è
          // esattamente il caso in cui prima non restava niente da leggere.
          const daFile = leggiDiario(fileDiario);
          resolve({
            ok: false,
            stato: "timeout",
            log: daFile.length > 0 ? daFile : diarioDiLancio(),
            messaggio:
              "Il robot ci ha messo troppo: l'ho fermato. Riprova (browser chiuso, Chrome chiuso).",
          });
        }
      },
      attesaMs,
    );

    /** Col passo-passo del file quando quello dell'esito manca (vedi nuovoDiario). */
    const colDiario = (e: EsitoRobot): EsitoRobot => {
      if (e.log && e.log.length > 0) return e;
      const daFile = leggiDiario(fileDiario);
      return { ...e, log: daFile.length > 0 ? daFile : diarioDiLancio() };
    };

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
            resolve(colDiario(JSON.parse(m[1]) as EsitoRobot));
            return;
          } catch {
            /* cade sul fallback */
          }
        }
      }
      resolve(colDiario(fallback));
    };

    child.on("close", (code) =>
      chiudi({
        ok: false,
        stato: "senza-esito",
        messaggio:
          out.trim().slice(-300) || `Robot terminato (codice ${code}) senza esito leggibile.`,
        log: diarioDiLancio(),
      }),
    );
    child.on("error", (e) =>
      chiudi({
        ok: false,
        stato: "avvio-fallito",
        messaggio: `Non riesco ad avviare il robot: ${e.message}`,
      }),
    );
  });
}
