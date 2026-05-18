import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STORE = new URL('../positions.json', import.meta.url);

function load() {
  if (!existsSync(STORE)) return {};
  try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function save(o) {
  writeFileSync(STORE, JSON.stringify(o, null, 2), { mode: 0o600 });
}

const keyOf = (userId, token) => `${userId}:${token.toLowerCase()}`;

// Posición: lo comprado/vendido VÍA ESTE BOT (para poder calcular PnL).
// { bnbIn, tokensIn, bnbOut, tokensOut }
export function getPosition(userId, token) {
  return load()[keyOf(userId, token)] || null;
}

export function recordBuy(userId, token, bnbSpent, tokensReceived) {
  const o = load();
  const k = keyOf(userId, token);
  const p = o[k] || { bnbIn: 0, tokensIn: 0, bnbOut: 0, tokensOut: 0 };
  p.bnbIn += Number(bnbSpent);
  p.tokensIn += Number(tokensReceived);
  o[k] = p;
  save(o);
  return p;
}

export function recordSell(userId, token, tokensSold, bnbReceived) {
  const o = load();
  const k = keyOf(userId, token);
  const p = o[k] || { bnbIn: 0, tokensIn: 0, bnbOut: 0, tokensOut: 0 };
  p.bnbOut += Number(bnbReceived);
  p.tokensOut += Number(tokensSold);
  o[k] = p;
  save(o);
  return p;
}

export function resetPosition(userId, token) {
  const o = load();
  delete o[keyOf(userId, token)];
  save(o);
}

/**
 * PnL no realizado de lo que aún se tiene (según precio actual en BNB),
 * más el BNB ya realizado por ventas previas.
 */
export function computePnl(pos, priceBnb) {
  if (!pos || pos.tokensIn <= 0) return null;
  const avgCost = pos.bnbIn / pos.tokensIn;            // BNB por token
  const heldTracked = Math.max(pos.tokensIn - pos.tokensOut, 0);
  const costOfHeld = avgCost * heldTracked;
  const curVal = heldTracked * priceBnb;
  const unrealPct = costOfHeld > 0 ? (curVal / costOfHeld - 1) * 100 : null;
  const unrealBnb = curVal - costOfHeld;
  return {
    bnbIn: pos.bnbIn,
    realizedBnb: pos.bnbOut,
    heldTracked,
    costOfHeld,
    curVal,
    unrealPct,
    unrealBnb,
  };
}
