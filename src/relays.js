import { config } from './config.js';

// Envío de bundles vía eth_sendBundle (basado en c1.json/c2.json).
// txs = array de tx FIRMADAS en hex (0x...).

async function postBundle(url, name, txs, maxBlock, id) {
  const payload = {
    jsonrpc: '2.0',
    id,
    method: 'eth_sendBundle',
    params: [{ txs, maxBlockNumber: maxBlock }],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(`${name}: ${json.error.message || JSON.stringify(json.error)}`);
  return { relay: name, result: json.result ?? json };
}

export function sendBlockRazor(txs, maxBlock) {
  return postBundle(config.relays.blockRazor, 'BlockRazor', txs, maxBlock, '1');
}

export function sendPuissant(txs, maxBlock) {
  return postBundle(config.relays.puissant, 'Puissant', txs, maxBlock, 48);
}

/**
 * Manda el bundle a TODOS los relays en paralelo. Basta con que uno acepte.
 * @param {string[]} txs  txs firmadas (hex)
 * @param {number} currentBlock  número de bloque actual
 * @param {number} plusBlock  cuántos bloques de ventana
 */
export async function sendBundle(txs, currentBlock, plusBlock = config.bundleBlocks) {
  const maxBlock = Number(currentBlock) + Number(plusBlock);

  // Modo diagnóstico: enviar SOLO a un relay.
  const only = config.onlyRelay;
  const jobs = [];
  if (only === 'blockrazor') {
    jobs.push(sendBlockRazor(txs, maxBlock));
  } else if (only === 'puissant') {
    jobs.push(sendPuissant(txs, maxBlock));
  } else {
    jobs.push(sendBlockRazor(txs, maxBlock), sendPuissant(txs, maxBlock));
  }
  // First-win: resolvemos en cuanto UN relay acepta; los demás siguen en
  // background (la tx igual les llegó → misma protección, sin esperar al lento).
  const accepted = [];
  const errs = [];
  const tracked = jobs.map((j) =>
    j.then((v) => { accepted.push(v.relay); return v; })
     .catch((e) => { errs.push(e?.message || String(e)); throw e; })
  );

  // Objeto de resultado: el simulatedRevertHint se actualiza después si
  // un relay reporta que la tx revertiría (background tracker).
  const result = { accepted: [], maxBlock, simulatedRevertHint: false };

  // Tracker tardío: detecta señales de "tx va a revertir" en cualquier relay.
  Promise.allSettled(tracked).then(() => {
    if (errs.some(isRevertSimError)) result.simulatedRevertHint = true;
    if (errs.length) console.warn('[bundle] relay(s) con error:', errs.join(' | '));
  });

  try {
    const first = await Promise.any(tracked);
    result.accepted = [first.relay];
    return result;
  } catch {
    // TODOS los relays fallaron. Si todos por revert-sim → hint=true.
    if (errs.length && errs.every(isRevertSimError)) result.simulatedRevertHint = true;
    const err = new Error(`Ningún relay aceptó el bundle: ${errs.join(' | ')}`);
    err.simulatedRevertHint = result.simulatedRevertHint;
    throw err;
  }
}

// Detecta mensajes de relay que indican que la tx revertiría al ejecutar.
// BlockRazor: "non-reverting tx in bundle failed". Otros pueden decir
// "execution reverted" / "would revert" / "would fail".
function isRevertSimError(msg) {
  const m = String(msg || '').toLowerCase();
  return m.includes('non-reverting tx in bundle failed') ||
         m.includes('execution reverted') ||
         m.includes('would revert') ||
         m.includes('would fail');
}
