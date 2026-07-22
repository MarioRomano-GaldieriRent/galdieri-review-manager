/**
 * Filtri SVG del materiale vetro.
 *
 * Il vetro non è una sfumatura: è una superficie che DEVIA la luce che la
 * attraversa. Qui sotto ci sono i filtri che fanno proprio questo, applicati
 * con backdrop-filter — che agisce solo su ciò che sta dietro l'elemento.
 * È la stessa cosa che succede davvero: lo sfondo si deforma, mentre il testo
 * appoggiato sopra resta perfettamente nitido.
 *
 * Il nodo <svg> non può stare in display:none, altrimenti i browser
 * disattivano i filtri: si nasconde con dimensione zero.
 */
export function GlassFilters() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        {/* Rifrazione morbida: vetro spesso e colato, per i riquadri grandi. */}
        <filter id="vetro-rifrazione" x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.006 0.010"
            numOctaves={2}
            seed={7}
            result="rumore"
          />
          <feGaussianBlur in="rumore" stdDeviation="7" result="mappa" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="mappa"
            scale="26"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>

        {/* Rifrazione più stretta e nervosa, per i nodi: la deformazione si
            legge anche su superfici piccole. */}
        <filter id="vetro-rifrazione-fine" x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.014 0.020"
            numOctaves={2}
            seed={19}
            result="rumore"
          />
          <feGaussianBlur in="rumore" stdDeviation="4" result="mappa" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="mappa"
            scale="14"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>

        {/* Grana finissima: toglie l'aria di "gradiente CSS" allo sfondo. */}
        <filter id="grana">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves={3}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
    </svg>
  );
}
