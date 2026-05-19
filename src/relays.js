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
  const results = await Promise.allSettled(jobs);
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const errs = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message || String(r.reason));
  if (ok.length === 0) {
    throw new Error(`Ningún relay aceptó el bundle: ${errs.join(' | ')}`);
  }
  if (errs.length) console.warn('[bundle] relay(s) con error:', errs.join(' | '));
  return { accepted: ok.map((o) => o.relay), maxBlock };
}
