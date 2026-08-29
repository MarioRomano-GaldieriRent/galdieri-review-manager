"use client";

import { useRouter } from "next/navigation";

// Icona "Aggiorna" (refresh morbido della vista corrente). Riusa lo stile
// .pub-aggiorna dei tab. Usata nella suite di test (Automazioni): ricarica la
// posta e la lista senza cambiare pagina.
export function Aggiorna({ title = "Aggiorna la vista" }: { title?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="pub-aggiorna"
      title={title}
      aria-label="Aggiorna la vista"
      onClick={() => router.refresh()}
    >
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  );
}
