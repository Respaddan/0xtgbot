// Rastreo con timestamps de cada fase de una operación.
// Imprime: fecha/hora, ms totales desde el inicio y Δ desde el paso anterior.

function stamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function makeTrace(label) {
  const t0 = Date.now();
  let tPrev = t0;
  const log = (msg) => {
    const now = Date.now();
    console.log(
      `⏱ [${stamp()}] (+${now - t0}ms | Δ${now - tPrev}ms) ${label} → ${msg}`
    );
    tPrev = now;
  };
  log('inicio');
  return { log };
}

// Tracer "vacío" para llamadas que no pasan trace (no rompe nada).
export const noTrace = { log: () => {} };
