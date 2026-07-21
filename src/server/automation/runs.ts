import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { Esecuzione } from "./types";

// Registro delle esecuzioni: serve a rivedere cosa è successo dopo aver
// premuto "Esegui". Si conservano le ultime 100, in ordine dalla più recente.
const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "automation-runs.json");
const MAX = 100;

export async function caricaEsecuzioni(): Promise<Esecuzione[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf8")) as Esecuzione[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function registraEsecuzione(e: Esecuzione): Promise<void> {
  const tutte = await caricaEsecuzioni();
  tutte.unshift(e);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(tutte.slice(0, MAX), null, 2), "utf8");
}

export async function svuotaEsecuzioni(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, "[]", "utf8");
}

/** Cancella una singola esecuzione, così la si può rifare da capo. */
export async function eliminaEsecuzione(id: string): Promise<void> {
  const tutte = await caricaEsecuzioni();
  const rimaste = tutte.filter((e) => e.id !== id);
  if (rimaste.length === tutte.length) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rimaste, null, 2), "utf8");
}

/** Ultima esecuzione per ciascuna recensione. */
export async function ultimePerRecensione(): Promise<Map<string, Esecuzione>> {
  const m = new Map<string, Esecuzione>();
  for (const e of await caricaEsecuzioni()) {
    if (!m.has(e.recensione.chiave)) m.set(e.recensione.chiave, e);
  }
  return m;
}
