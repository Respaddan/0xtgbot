import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import { config } from './config.js';
import { ERC20_ABI, FACTORY_ABI, PAIR_ABI, ROUTER_V2_ABI } from './abis.js';

// Provider de LECTURA: blxrbdn HTTP es el más rápido medido (~125ms warm,
// ~590ms cold) -> primario. publicnode HTTP/WSS quedan solo de respaldo.
// stallTimeout corto para que un primario lento falle rápido al respaldo.
let readProvider;

function buildReadProvider() {
  const opts = { staticNetwork: ethers.Network.from(config.chainId) };
  const blxr = new ethers.JsonRpcProvider(config.httpRpc, config.chainId, opts);
  const pub = new ethers.JsonRpcProvider(config.httpReadRpc, config.chainId, opts);
  const wss = new ethers.WebSocketProvider(config.wssRpc, config.chainId);

  try {
    wss.websocket.addEventListener?.('close', resetReadProvider);
    wss.websocket.addEventListener?.('error', resetReadProvider);
  } catch { /* algunas versiones no exponen websocket aún */ }

  return new ethers.FallbackProvider(
    [
      { provider: blxr, priority: 1, stallTimeout: 700, weight: 1 },
      { provider: pub, priority: 2, stallTimeout: 900, weight: 1 },
      { provider: wss, priority: 3, stallTimeout: 1200, weight: 1 },
    ],
    config.chainId,
    { quorum: 1 }
  );
}

export function getReadProvider() {
  if (!readProvider) readProvider = buildReadProvider();
  return readProvider;
}

export function resetReadProvider() {
  readProvider = null;
}

// Provider WSS dedicado para enviar/esperar tx (block number, receipt,
// waitForTransaction, broadcast). WSS = push, más rápido que pollear HTTPS.
let wssProvider;
export function getWssProvider() {
  if (!wssProvider) {
    wssProvider = new ethers.WebSocketProvider(config.wssRpc, config.chainId);
    try {
      const drop = () => { wssProvider = null; };
      wssProvider.websocket.addEventListener?.('close', drop);
      wssProvider.websocket.addEventListener?.('error', drop);
    } catch { /* algunas versiones no exponen websocket aún */ }
  }
  return wssProvider;
}

// Providers para "carrera": el quote se pide a varios y gana el 1ro que
// responda → corta los picos de cola de un solo RPC lento.
let raceProviders;
export function getRaceProviders() {
  if (!raceProviders) {
    const opts = { staticNetwork: ethers.Network.from(config.chainId) };
    const urls = [
      config.httpRpc,                 // blxrbdn
      'https://bsc-dataseed.bnbchain.org',
      config.httpReadRpc,             // publicnode http
    ];
    raceProviders = urls.map((u) => new ethers.JsonRpcProvider(u, config.chainId, opts));
  }
  return raceProviders;
}

// Ejecuta fn(provider) en todos los race providers; devuelve el 1er éxito.
export async function raceRead(fn) {
  const ps = getRaceProviders().map((p) => fn(p));
  return Promise.any(ps);
}

// --- Block number cacheado en background (0 RPC en el hot path) ---
let lastBlock = 0;
let blockWatcher = null;

export function startBlockWatcher(intervalMs = 300) {
  if (blockWatcher) return;
  const tick = async () => {
    try {
      const b = await getWriteProvider().getBlockNumber();
      if (b > lastBlock) lastBlock = b;
    } catch { /* reintenta al próximo tick */ }
  };
  tick();
  blockWatcher = setInterval(tick, intervalMs);
  blockWatcher.unref?.();
}

// Bloque actual sin pagar RPC (usa el cache del watcher). Si aún no hay
// cache, hace una lectura puntual de respaldo.
export async function getCachedBlockNumber() {
  if (lastBlock) return lastBlock;
  try { lastBlock = await getWriteProvider().getBlockNumber(); } catch { /* 0 */ }
  return lastBlock;
}

// Corta cualquier lectura colgada para que el bot nunca se quede pegado.
export async function withTimeout(promise, ms, label = 'RPC') {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error(`Timeout de ${label} (${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

// Provider de ESCRITURA (HTTP blxrbdn) + wallet firmante
let writeProvider;
export function getWriteProvider() {
  if (!writeProvider) {
    writeProvider = new ethers.JsonRpcProvider(config.httpRpc, config.chainId, {
      staticNetwork: true,
    });
  }
  return writeProvider;
}

export function getWallet() {
  if (!config.privateKey) throw new Error('No hay PRIVATE_KEY configurada');
  const pk = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
  return new ethers.Wallet(pk, getWriteProvider());
}

// --- Multicall3 (mismo address en BSC y casi toda EVM) ---
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
];
const iMc3 = new ethers.Interface(MC3_ABI);
const iErc20 = new ethers.Interface(ERC20_ABI);
const iFactory = new ethers.Interface(FACTORY_ABI);
const iPair = new ethers.Interface(PAIR_ABI);

// Una sola ida y vuelta para N llamadas. Cada call: {target, iface, fn, args, def}
async function multicall(calls) {
  const mc = new ethers.Contract(MULTICALL3, MC3_ABI, getReadProvider());
  const payload = calls.map((c) => ({
    target: c.target,
    allowFailure: true,
    callData: c.iface.encodeFunctionData(c.fn, c.args || []),
  }));
  const res = await mc.aggregate3(payload);
  return calls.map((c, i) => {
    const r = res[i];
    if (!r || !r.success || r.returnData === '0x') return c.def;
    try {
      const d = c.iface.decodeFunctionResult(c.fn, r.returnData);
      return c.raw ? d : d[0];
    } catch {
      return c.def;
    }
  });
}

// Balances (BNB + token) de varias wallets en UN solo multicall.
// Devuelve [{ address, bnb, tokenBalRaw, tokenBal }, ...]
export async function getMultiWalletBalances(addresses, tokenAddr, decimals = 18) {
  if (!addresses?.length) return [];
  const calls = [];
  for (const a of addresses) {
    calls.push({ target: MULTICALL3, iface: iMc3, fn: 'getEthBalance', args: [a], def: 0n });
    calls.push({ target: tokenAddr, iface: iErc20, fn: 'balanceOf', args: [a], def: 0n });
  }
  const r = await multicall(calls);
  const out = [];
  for (let i = 0; i < addresses.length; i++) {
    const wei = r[i * 2] ?? 0n;
    const tokRaw = r[i * 2 + 1] ?? 0n;
    out.push({
      address: addresses[i],
      bnb: new Decimal(wei.toString()).div('1e18').toNumber(),
      tokenBalRaw: tokRaw,
      tokenBal: new Decimal(tokRaw.toString()).div(`1e${decimals}`).toNumber(),
    });
  }
  return out;
}

// Dirección del par V2 por CREATE2 (sin preguntar al Factory).
export function pairFor(a, b) {
  const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const salt = ethers.solidityPackedKeccak256(['address', 'address'], [t0, t1]);
  return ethers.getCreate2Address(config.PANCAKE_V2_FACTORY, salt, config.PANCAKE_INIT_CODE_HASH);
}

// Metadatos inmutables del token (no cambian nunca) -> cache permanente.
const metaCache = new Map(); // addr -> { name, symbol, decimals }

const QUOTES = [
  { addr: config.WBNB, sym: 'WBNB', isNative: true, dec: 18 },
  { addr: config.USDT, sym: 'USDT', isNative: false, dec: 18 },
  { addr: config.BUSD, sym: 'BUSD', isNative: false, dec: 18 },
];
const BNB_USDT_PAIR = pairFor(config.WBNB, config.USDT);

let bnbPriceCache = { value: 0, ts: 0 };
export const getBnbPriceUsd = async () => bnbPriceCache.value;

/**
 * Toda la info del token en UN solo multicall (1 ida y vuelta).
 * Los pares se calculan por CREATE2 (sin preguntar al Factory).
 * Metadatos cacheados y precio de BNB cacheado 30s => Refrescar casi instantáneo.
 */
export async function getTokenInfo(tokenAddr, { forceBnb = false, wallet = null } = {}) {
  tokenAddr = ethers.getAddress(tokenAddr);
  const cachedMeta = metaCache.get(tokenAddr);
  // forceBnb=true (botón Refrescar) ignora el cache de 30s y trae el precio vivo.
  const bnbFresh = !forceBnb && bnbPriceCache.value > 0 && Date.now() - bnbPriceCache.ts < 30_000;

  // Direcciones de los pares candidatos, calculadas localmente.
  const candPairs = QUOTES.map((q) => pairFor(tokenAddr, q.addr));

  const calls = [];
  if (!cachedMeta) {
    calls.push(
      { target: tokenAddr, iface: iErc20, fn: 'name', def: 'Unknown' },
      { target: tokenAddr, iface: iErc20, fn: 'symbol', def: '???' },
      { target: tokenAddr, iface: iErc20, fn: 'decimals', def: 18 }
    );
  }
  calls.push({ target: tokenAddr, iface: iErc20, fn: 'totalSupply', def: 0n });
  for (const p of candPairs) {
    calls.push(
      { target: p, iface: iPair, fn: 'token0', def: ethers.ZeroAddress },
      { target: p, iface: iPair, fn: 'getReserves', raw: true, def: null }
    );
  }
  if (!bnbFresh) {
    calls.push(
      { target: BNB_USDT_PAIR, iface: iPair, fn: 'token0', def: ethers.ZeroAddress },
      { target: BNB_USDT_PAIR, iface: iPair, fn: 'getReserves', raw: true, def: null }
    );
  }
  if (wallet) {
    calls.push(
      { target: MULTICALL3, iface: iMc3, fn: 'getEthBalance', args: [wallet], def: 0n },
      { target: tokenAddr, iface: iErc20, fn: 'balanceOf', args: [wallet], def: 0n }
    );
  }

  const r = await multicall(calls);
  let idx = 0;
  let name, symbol, decimals;
  if (cachedMeta) {
    ({ name, symbol, decimals } = cachedMeta);
  } else {
    name = r[idx++];
    symbol = r[idx++];
    decimals = Number(r[idx++]);
    metaCache.set(tokenAddr, { name, symbol, decimals });
  }
  const totalSupply = r[idx++];

  const pairData = QUOTES.map(() => ({ t0: r[idx++], res: r[idx++] }));

  let bnbUsd = bnbPriceCache.value;
  if (!bnbFresh) {
    const bnbT0 = r[idx++];
    const bnbRes = r[idx++];
    if (bnbRes) {
      const wbnbIs0 = String(bnbT0).toLowerCase() === config.WBNB.toLowerCase();
      const rWbnb = new Decimal((wbnbIs0 ? bnbRes[0] : bnbRes[1]).toString());
      const rUsdt = new Decimal((wbnbIs0 ? bnbRes[1] : bnbRes[0]).toString());
      if (rWbnb.gt(0)) {
        bnbUsd = rUsdt.div(rWbnb).toNumber();
        bnbPriceCache = { value: bnbUsd, ts: Date.now() };
      }
    }
  }

  let walletBnb = 0;
  let tokenBalRaw = 0n;
  if (wallet) {
    walletBnb = new Decimal((r[idx++] ?? 0n).toString()).div('1e18').toNumber();
    tokenBalRaw = r[idx++] ?? 0n;
  }

  // Primer quote con par real (reservas presentes y > 0): WBNB > USDT > BUSD
  let qi = pairData.findIndex((d) => d.res && (BigInt(d.res[0]) > 0n || BigInt(d.res[1]) > 0n));
  const pairExists = qi >= 0;
  const quote = pairExists ? QUOTES[qi] : QUOTES[0];
  const pairAddr = pairExists ? candPairs[qi] : ethers.ZeroAddress;

  let priceUsd = 0;
  let priceBnb = 0;
  let liqUsd = 0;
  if (pairExists) {
    const { t0, res } = pairData[qi];
    const tokenIs0 = String(t0).toLowerCase() === tokenAddr.toLowerCase();
    const rToken = new Decimal((tokenIs0 ? res[0] : res[1]).toString()).div(`1e${decimals}`);
    const rQuote = new Decimal((tokenIs0 ? res[1] : res[0]).toString()).div(`1e${quote.dec}`);
    if (rToken.gt(0)) {
      const priceInQuote = rQuote.div(rToken);
      priceUsd = quote.isNative ? priceInQuote.mul(bnbUsd).toNumber() : priceInQuote.toNumber();
      priceBnb = quote.isNative
        ? priceInQuote.toNumber()
        : (bnbUsd > 0 ? priceInQuote.toNumber() / bnbUsd : 0);
      // Lado único (valor del lado WBNB/quote) = liquidez real de salida.
      // Coincide con BasedBot/Sigma/Bloom (~$47k), no el pool ×2.
      liqUsd = (quote.isNative ? rQuote.mul(bnbUsd) : rQuote).toNumber();
    }
  }

  const supply = new Decimal(totalSupply.toString()).div(`1e${decimals}`);
  const mcapUsd = supply.mul(priceUsd).toNumber();
  const liqPct = mcapUsd > 0 ? (liqUsd / mcapUsd) * 100 : 0;
  const tokenBal = new Decimal(tokenBalRaw.toString()).div(`1e${decimals}`).toNumber();

  return {
    address: tokenAddr,
    name, symbol, decimals,
    pairAddr,
    pairExists,
    quoteSymbol: quote.sym,
    quoteAddr: quote.addr,
    quoteIsNative: quote.isNative,
    priceUsd,
    priceBnb,
    mcapUsd,
    liqUsd,
    liqPct,
    bnbUsd,
    walletBnb,
    tokenBal,
    tokenBalRaw,
  };
}

/** Costo aproximado de gas (USD) para una operación buy/sell */
export function estimateCostUsd(gwei, bnbUsd, side) {
  const gasUnits = side === 'sell' ? 320000 : 260000;
  const bnbCost = new Decimal(gwei).mul(1e9).mul(gasUnits).div(1e18);
  return bnbCost.mul(bnbUsd).toNumber();
}

/**
 * Calienta la conexión al arrancar: abre el keep-alive HTTP y precarga el
 * precio de BNB, para que el PRIMER contrato que pegues no pague el cold start.
 */
export async function warmup() {
  try {
    const mc = new ethers.Contract(config.MULTICALL3, MC3_ABI, getReadProvider());
    const t0 = iPair.encodeFunctionData('token0', []);
    const gr = iPair.encodeFunctionData('getReserves', []);
    const res = await mc.aggregate3([
      { target: BNB_USDT_PAIR, allowFailure: true, callData: t0 },
      { target: BNB_USDT_PAIR, allowFailure: true, callData: gr },
    ]);
    const bnbT0 = iPair.decodeFunctionResult('token0', res[0].returnData)[0];
    const rr = iPair.decodeFunctionResult('getReserves', res[1].returnData);
    const wbnbIs0 = String(bnbT0).toLowerCase() === config.WBNB.toLowerCase();
    const rWbnb = new Decimal((wbnbIs0 ? rr[0] : rr[1]).toString());
    const rUsdt = new Decimal((wbnbIs0 ? rr[1] : rr[0]).toString());
    if (rWbnb.gt(0)) bnbPriceCache = { value: rUsdt.div(rWbnb).toNumber(), ts: Date.now() };
    return bnbPriceCache.value;
  } catch {
    return 0;
  }
}

export { ROUTER_V2_ABI };
