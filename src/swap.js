import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import { config } from './config.js';
import { ERC20_ABI, ROUTER_V2_ABI } from './abis.js';
import { getReadProvider, getWriteProvider } from './chain.js';

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

  const [quote, nonce, estimatedGas] = await Promise.all([
    getV2Quote(routerAddress, path, amountIn).then((r) => r.amountOut).catch(() => 0n),
    wallet.getNonce(),
    writeProvider.estimateGas({
      from: wallet.address,
      to: routerAddress,
      data: buildSwapV2Data(iface, METHODS, side, isNative, amountIn, 0n, path, wallet.address, deadline),
      ...(side === 'buy' && isNative ? { value: amountIn } : {}),
    }).catch(() => 1_500_000n),
  ]);

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
  const sent = await wallet.sendTransaction(tx);
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
  const sent = await wallet.sendTransaction(tx);
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
