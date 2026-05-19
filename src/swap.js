import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import { config } from './config.js';
import { ERC20_ABI, ROUTER_V2_ABI } from './abis.js';
import { getReadProvider, getWriteProvider } from './chain.js';
import { sendBundle } from './relays.js';

// Espera el receipt poll-eando rápido el endpoint más veloz (blxrbdn).
// Mejor que el push WSS en la práctica: ~POLL_MS de gap, endpoint más rápido.
const POLL_MS = 250;
async function waitForReceipt(provider, hash, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await provider.getTransactionReceipt(hash);
      if (r) return r;
    } catch { /* reintenta */ }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}

/**
 * Firma la tx localmente y la envía:
 *  - si useBundle: eth_sendBundle a los relays MEV (tx privada, anti-sandwich)
 *  - si no, o como fallback: mempool público
 * Devuelve { hash, wait } compatible con el flujo anterior.
 */
async function signAndSend(wallet, tx) {
  const rp = getWriteProvider();        // blxrbdn: lecturas/espera/envío (más rápido + Protect)
  const full = { ...tx, type: 0 };      // BSC = legacy (type 0)
  delete full.from;

  const raw = await wallet.signTransaction(full);
  const parsed = ethers.Transaction.from(raw);
  const hash = parsed.hash;
  const nonce = parsed.nonce;

  // Cómo terminó entrando la tx (para el log al confirmar).
  const route = { via: null, accepted: [] };
  let submitBlock = 0;

  if (config.useBundle) {
    const blk = await rp.getBlockNumber().catch(() => 0);
    submitBlock = blk;
    const info = await sendBundle([raw], blk, config.bundleBlocks);
    route.accepted = info.accepted;
    console.log(`[bundle] enviado ${hash} | nonce ${nonce} | aceptado por ${info.accepted.join(', ')} (bloque ${blk}, maxBlock ${info.maxBlock})`);

    if (config.fallbackMode === 'instant') {
      // MÁX VELOCIDAD: en paralelo al bundle, vía blxrbdn Protect RPC
      // (BSC Chain 56) → NO va al mempool P2P público, sigue MEV-protegido.
      route.via = 'bundle + blxrbdn Protect (instant)';
      await rp.broadcastTransaction(raw).catch(() => {});
      console.log(`[bundle] ⚡ instant: enviado también vía blxrbdn Protect RPC: ${hash}`);
    } else if (config.bundlePublicFallback) {
      // Fallback rápido: a los N bloques observados, sin esperar al maxBlock.
      const fallbackAt = blk + config.bundleFallbackBlocks;
      (async () => {
        const hardLimit = Date.now() + config.bundleFallbackMs + 3000;
        while (Date.now() < hardLimit) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            if (await rp.getTransactionReceipt(hash)) return; // ya entró (bundle)
            const cur = await rp.getBlockNumber().catch(() => 0);
            if (cur > fallbackAt) {
              route.via = 'fallback blxrbdn Protect';
              await rp.broadcastTransaction(raw).catch(() => {});
              console.log(`[bundle] ⏬ no entró en ${config.bundleFallbackBlocks} bloque(s), fallback vía blxrbdn Protect RPC: ${hash}`);
              return;
            }
          } catch { /* reintenta */ }
        }
      })();
    }
  } else {
    route.via = 'blxrbdn Protect (sin bundle)';
    await rp.broadcastTransaction(raw);
    console.log(`[tx] enviado vía blxrbdn Protect RPC: ${hash} | nonce ${nonce}`);
  }

  return {
    hash,
    nonce,
    wait: async () => {
      const r = await waitForReceipt(rp, hash, 90_000);
      if (r) {
        let via;
        if (route.via) {
          via = route.via; // 'fallback público' o 'mempool (sin bundle)'
        } else if (route.accepted.length === 1) {
          via = `bundle ✅ ${route.accepted[0]}`; // solo un relay aceptó → atribuible
        } else {
          via = `bundle ✅ ${route.accepted.join('/')} (no atribuible a uno)`;
        }
        const ok = r.status === 1 ? 'OK' : 'REVERTED ⚠️';
        const pos = r.index ?? r.transactionIndex; // posición de la tx en el bloque
        const delta = submitBlock ? r.blockNumber - submitBlock : null;

        // Solo en modo instant: heurística (NO certeza) de por dónde entró.
        let guess = '';
        if (config.fallbackMode === 'instant' && config.useBundle) {
          const likelyBundle = delta != null && delta <= 1 && pos <= 8;
          guess = likelyBundle
            ? ' | ≈probable BUNDLE relay (rápido + pos baja, heurística)'
            : ' | ≈probable blxrbdn Protect (tardó/pos alta, heurística)';
        }
        const dly = delta != null ? ` | +${delta} bloque(s)` : '';
        console.log(`[tx] confirmada vía ${via} | nonce ${nonce} | bloque ${r.blockNumber}${dly} | pos ${pos} en bloque | ${ok}${guess} | ${hash}`);
      } else {
        console.log(`[tx] ⚠️ sin receipt tras timeout: ${hash} | nonce ${nonce}`);
      }
      return r;
    },
  };
}

// Métodos del router según si el lado "quote" es el token nativo (WBNB)
const METHODS = {
  buy: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
  sell: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
};

async function getV2Quote(routerAddress, path, amountIn) {
  const router = new ethers.Contract(routerAddress, ROUTER_V2_ABI, getReadProvider());
  const amounts = await router.getAmountsOut(amountIn, path);
  return { amountOut: amounts[amounts.length - 1] };
}

/**
 * Adaptado del código original: construye la data y la tx del swap V2.
 */
function buildSwapV2Data(iface, methods, side, isNative, amountIn, amountOutMin, path, recipient, deadline) {
  if (side === 'buy') {
    const buyMethod = isNative ? methods.buy : 'swapExactTokensForTokensSupportingFeeOnTransferTokens';
    if (isNative && buyMethod === 'swapExactETHForTokensSupportingFeeOnTransferTokens') {
      return iface.encodeFunctionData(buyMethod, [amountOutMin, path, recipient, deadline]);
    }
    return iface.encodeFunctionData(buyMethod, [amountIn, amountOutMin, path, recipient, deadline]);
  }
  const sellMethod = isNative ? methods.sell : 'swapExactTokensForTokensSupportingFeeOnTransferTokens';
  return iface.encodeFunctionData(sellMethod, [amountIn, amountOutMin, path, recipient, deadline]);
}

async function buildSwapV2Tx({ amountIn, decimals, path, gwei, slippage, side, wallet }) {
  const iface = new ethers.Interface(ROUTER_V2_ABI);
  const routerAddress = config.PANCAKE_V2_ROUTER;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const isNative =
    path[0].toLowerCase() === config.WBNB.toLowerCase() ||
    path[path.length - 1].toLowerCase() === config.WBNB.toLowerCase();

  const writeProvider = getWriteProvider();

  const [quote, nWrite, nRead, estimatedGas] = await Promise.all([
    getV2Quote(routerAddress, path, amountIn).then((r) => r.amountOut).catch(() => 0n),
    writeProvider.getTransactionCount(wallet.address, 'pending').catch(() => 0),
    getReadProvider().getTransactionCount(wallet.address, 'pending').catch(() => 0),
    writeProvider.estimateGas({
      from: wallet.address,
      to: routerAddress,
      data: buildSwapV2Data(iface, METHODS, side, isNative, amountIn, 0n, path, wallet.address, deadline),
      ...(side === 'buy' && isNative ? { value: amountIn } : {}),
    }).catch(() => 1_500_000n),
  ]);

  // Nonce PENDING y de la fuente más adelantada (evita "nonce too low").
  const nonce = Math.max(Number(nWrite), Number(nRead));

  const amountOutMin = BigInt(
    new Decimal(quote.toString()).mul(100 - slippage).div(100).toFixed(0)
  );
  const data = buildSwapV2Data(iface, METHODS, side, isNative, amountIn, amountOutMin, path, wallet.address, deadline);

  return {
    to: routerAddress,
    gasLimit: BigInt(new Decimal(estimatedGas.toString()).mul(1.35).toFixed(0)),
    gasPrice: ethers.parseUnits(String(gwei), 'gwei'),
    nonce,
    data,
    chainId: config.chainId,
    ...(side === 'buy' && isNative ? { value: amountIn } : {}),
  };
}

async function ensureAllowance(wallet, tokenAddr, amountIn) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const current = await token.allowance(wallet.address, config.PANCAKE_V2_ROUTER);
  if (current >= amountIn) return null;
  const tx = await token.approve(config.PANCAKE_V2_ROUTER, ethers.MaxUint256);
  await tx.wait();
  return tx.hash;
}

/**
 * Ejecuta una compra.
 * @param amountBnb string en BNB (ej "0.1")
 */
export async function executeBuy(wallet, tokenInfo, amountBnb, slippage, gwei) {
  const token = new ethers.Contract(tokenInfo.address, ERC20_ABI, wallet);
  const path = [config.WBNB, tokenInfo.address];
  const amountIn = ethers.parseEther(String(amountBnb));

  // balanceOf y construcción de la tx EN PARALELO (no en serie).
  const [balBefore, tx] = await Promise.all([
    token.balanceOf(wallet.address).catch(() => 0n),
    buildSwapV2Tx({ amountIn, decimals: 18, path, gwei, slippage, side: 'buy', wallet }),
  ]);
  const sent = await signAndSend(wallet, tx);
  await sent.wait(1);
  const balAfter = await token.balanceOf(wallet.address).catch(() => balBefore);

  const received = new Decimal((balAfter - balBefore).toString())
    .div(`1e${tokenInfo.decimals}`).toNumber();

  // Approve justo después de comprar: deja la venta futura instantánea.
  const approveHash = await ensureAllowance(wallet, tokenInfo.address, balAfter)
    .catch(() => null);

  return {
    hash: sent.hash,
    tokensReceived: received,
    bnbSpent: Number(amountBnb),
    approveHash,
  };
}

/**
 * Ejecuta una venta de un % del balance del token.
 */
export async function executeSell(wallet, tokenInfo, percent, slippage, gwei) {
  const token = new ethers.Contract(tokenInfo.address, ERC20_ABI, wallet);
  const balance = await token.balanceOf(wallet.address);
  if (balance === 0n) throw new Error('Balance del token = 0, nada que vender');

  const amountIn = (balance * BigInt(percent)) / 100n;
  if (amountIn === 0n) throw new Error('Cantidad a vender = 0');

  const approveHash = await ensureAllowance(wallet, tokenInfo.address, amountIn);

  const bnbBefore = await wallet.provider.getBalance(wallet.address);
  const path = [tokenInfo.address, config.WBNB];
  const tx = await buildSwapV2Tx({
    amountIn, decimals: tokenInfo.decimals, path, gwei, slippage, side: 'sell', wallet,
  });
  const sent = await signAndSend(wallet, tx);
  const receipt = await sent.wait(1);
  const bnbAfter = await wallet.provider.getBalance(wallet.address);

  // BNB obtenido del swap = delta de balance + gas gastado (para no descontarlo).
  const gasCost = (receipt?.gasUsed ?? 0n) * (receipt?.gasPrice ?? tx.gasPrice ?? 0n);
  const grossWei = (bnbAfter - bnbBefore) + gasCost;
  const bnbReceived = new Decimal((grossWei < 0n ? 0n : grossWei).toString())
    .div('1e18').toNumber();
  const tokensSold = new Decimal(amountIn.toString())
    .div(`1e${tokenInfo.decimals}`).toNumber();

  return { hash: sent.hash, approveHash, bnbReceived, tokensSold, soldAll: percent >= 100 };
}
