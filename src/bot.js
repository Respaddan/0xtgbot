import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';
import { config } from './config.js';
import { getTokenInfo, withTimeout, resetReadProvider, warmup, startBlockWatcher } from './chain.js';
import { executeBuy, executeSell } from './swap.js';
import { renderPanel, renderKeyboard, renderSellResult, closeExtra } from './ui.js';
import { authMiddleware, isOwner } from './auth.js';
import { getSignerFor, setUserWallet, removeUserWallet, getUserAddress } from './wallets.js';
import { getPosition, recordBuy, recordSell, resetPosition, computePnl } from './positions.js';
import { makeTrace } from './trace.js';

// Dirección de wallet del usuario para mostrar balances (o null si no tiene).
function walletOf(userId) {
  try { return getUserAddress(userId); } catch { return null; }
}

// Carga info del token + balances de la wallet + PnL, y lo deja en state.
async function refreshState(userId, state, { forceBnb = false } = {}) {
  const wallet = walletOf(userId);
  state.wallet = wallet;
  state.info = await loadInfo(state.token, { forceBnb, wallet });
  const pos = wallet ? getPosition(userId, state.token) : null;
  state.pnl = pos ? computePnl(pos, state.info.priceBnb) : null;
  return state.info;
}

if (!config.botToken) {
  console.error('Falta BOT_TOKEN en .env. Cópialo desde @BotFather.');
  process.exit(1);
}

const bot = new Telegraf(config.botToken, { handlerTimeout: 60_000 });

// 1ª línea de defensa: nadie fuera de la allowlist pasa de aquí (silencio total).
bot.use(authMiddleware());

// Consulta on-chain acotada: máx 18s; si falla, reinicia el provider WSS.
async function loadInfo(addr, opts = {}) {
  try {
    return await withTimeout(getTokenInfo(addr, opts), 18_000, 'consulta del token');
  } catch (e) {
    resetReadProvider();
    throw e;
  }
}

// Estado por mensaje del panel: clave `${chatId}:${messageId}`
const states = new Map();
const keyOf = (ctx) => `${ctx.chat.id}:${ctx.callbackQuery.message.message_id}`;

const SLIPPAGE_PRESETS = [5, 10, 15, 20, 30, 50];
const GWEI_PRESETS = [0.15, 0.2, 0.5, 0.75, 1];
const cycle = (arr, cur) => arr[(arr.indexOf(cur) + 1) % arr.length] ?? arr[0];

const ADDR_RE = /0x[a-fA-F0-9]{40}/;

bot.start((ctx) => {
  const owner = isOwner(ctx.from.id);
  const addr = (() => { try { return getUserAddress(ctx.from.id); } catch { return null; } })();
  return ctx.reply(
    '👋 Pega el contrato (CA) de un token de BSC y te muestro el panel de PancakeSwap V2.\n\n' +
    (owner
      ? '🔑 Eres el dueño: operas con la wallet del .env.'
      : 'Tu wallet: ' + (addr ? `\`${addr}\`` : '⚠️ no configurada. Usa /setwallet <private_key>')) +
    '\n\nComandos: /mywallet · /setwallet · /removewallet',
    { parse_mode: 'Markdown' }
  );
});

// El dueño NO setea wallet por aquí (usa el .env). Solo usuarios autorizados.
bot.command('setwallet', async (ctx) => {
  // Borra de inmediato el mensaje con la private key del historial del chat.
  await ctx.deleteMessage().catch(() => {});

  if (isOwner(ctx.from.id)) {
    return ctx.reply('Eres el dueño: tu wallet es la del .env, no se setea por chat.');
  }
  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const pk = parts[1];
  if (!pk) return ctx.reply('Uso: /setwallet <private_key>  (en chat privado; el mensaje se borra solo)');
  try {
    const address = setUserWallet(ctx.from.id, pk);
    return ctx.reply(`✅ Wallet guardada y cifrada.\nDirección: \`${address}\``, { parse_mode: 'Markdown' });
  } catch (e) {
    return ctx.reply(`❌ ${e.shortMessage || e.message}`);
  }
});

bot.command('mywallet', (ctx) => {
  try {
    const addr = getUserAddress(ctx.from.id);
    return addr
      ? ctx.reply(`Tu wallet:\n\`${addr}\``, { parse_mode: 'Markdown' })
      : ctx.reply('No tienes wallet configurada. Usa /setwallet <private_key>');
  } catch (e) {
    return ctx.reply(`❌ ${e.message}`);
  }
});

bot.command('removewallet', (ctx) => {
  if (isOwner(ctx.from.id)) return ctx.reply('La wallet del dueño se gestiona en el .env.');
  return ctx.reply(removeUserWallet(ctx.from.id) ? '🗑 Wallet eliminada.' : 'No tenías wallet guardada.');
});

// Pegan un contrato -> panel
bot.hears(ADDR_RE, async (ctx) => {
  const match = ctx.message.text.match(ADDR_RE);
  if (!match) return;
  let addr;
  try {
    addr = ethers.getAddress(match[0]);
  } catch {
    return ctx.reply('❌ Dirección inválida.');
  }

  // Todo junto: consultamos y respondemos un único mensaje completo.
  try {
    const state = {
      token: addr,
      info: null,
      side: 'buy',
      slipBuy: config.defaults.slippageBuy,
      slipSell: config.defaults.slippageSell,
      gwei: config.defaults.gwei,
    };
    await refreshState(ctx.from.id, state);
    const sent = await ctx.reply(
      renderPanel(state.info, state),
      { parse_mode: 'Markdown', disable_web_page_preview: true, ...renderKeyboard(state) }
    );
    states.set(`${ctx.chat.id}:${sent.message_id}`, state);
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ Error consultando el token:\n${e.shortMessage || e.message}`);
  }
});

// Cantidad personalizada (botón X/%): el siguiente número que envíes.
bot.on('text', async (ctx, next) => {
  const p = pendingInput.get(ctx.from.id);
  if (!p) return next();
  const raw = (ctx.message.text || '').trim().replace('%', '').replace(',', '.');
  const num = Number(raw);
  if (!isFinite(num) || num <= 0) {
    return ctx.reply('❌ Valor inválido. Envía solo un número (ej: `0.37` o `75`).',
      { parse_mode: 'Markdown' });
  }
  pendingInput.delete(ctx.from.id);
  const state = states.get(p.key);
  if (!state) return ctx.reply('⚠️ El panel expiró. Vuelve a pegar el contrato.');

  try {
    if (p.type === 'buy') {
      await ctx.reply(`⏳ Comprando ${num} BNB... (espera confirmación)`);
      await doBuy(ctx, ctx.from.id, state, p.key, num);
    } else {
      const pct = Math.min(num, 100);
      await ctx.reply(`⏳ Vendiendo ${pct}%... (espera confirmación)`);
      await doSell(ctx, ctx.from.id, state, p.key, pct);
    }
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ ${e.shortMessage || e.message}`);
  }
});

async function rerender(ctx, state) {
  try {
    await ctx.editMessageText(renderPanel(state.info, state), {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...renderKeyboard(state),
    });
  } catch (e) {
    // Editar a contenido idéntico no es un error real: lo ignoramos.
    if (!String(e?.description || e?.message).includes('message is not modified')) {
      throw e;
    }
  }
}

// Re-renderiza el panel por su clave (cuando no hay callback que editar,
// p.ej. tras una cantidad personalizada enviada por texto).
async function rerenderByKey(telegram, key, state) {
  const [chatId, msgId] = key.split(':');
  await telegram.editMessageText(
    Number(chatId), Number(msgId), undefined,
    renderPanel(state.info, state),
    { parse_mode: 'Markdown', disable_web_page_preview: true, ...renderKeyboard(state) }
  ).catch(() => {});
}

// Cantidades personalizadas pendientes: userId -> { type, key }
const pendingInput = new Map();

async function doBuy(ctx, userId, state, key, amount) {
  const tr = makeTrace(`COMPRA ${amount} BNB ${state.info?.symbol || ''}`);
  const signer = getSignerFor(userId);
  const { hash, tokensReceived, bnbSpent, approveHash } =
    await executeBuy(signer, state.info, String(amount), state.slipBuy, state.gwei, tr);
  recordBuy(userId, state.token, bnbSpent, tokensReceived);
  const lines = [
    `🟢 *Compra ejecutada*`,
    `💸 Gastado: *${amount} BNB*`,
    `📦 Recibido: *${tokensReceived}* ${state.info.symbol}`,
    `[Tx](https://bscscan.com/tx/${hash})`,
  ];
  if (approveHash) lines.push(`🔓 Approve: [Tx](https://bscscan.com/tx/${approveHash})`);
  // Mensaje de resultado y refresh del panel EN PARALELO (post-trade).
  const replyP = ctx.reply(lines.join('\n'), closeExtra())
    .then(() => tr.log('mensaje de resultado enviado a Telegram'));
  await refreshState(userId, state).catch(() => {});
  await rerenderByKey(ctx.telegram, key, state);
  await replyP.catch(() => {});
  tr.log('panel actualizado — FIN');
}

async function doSell(ctx, userId, state, key, pct) {
  const tr = makeTrace(`VENTA ${pct}% ${state.info?.symbol || ''}`);
  const signer = getSignerFor(userId);
  const { hash, approveHash, bnbReceived, tokensSold, soldAll } =
    await executeSell(signer, state.info, pct, state.slipSell, state.gwei, tr);
  recordSell(userId, state.token, tokensSold, bnbReceived);
  if (soldAll) resetPosition(userId, state.token);
  const { text, extra } = renderSellResult({
    symbol: state.info.symbol, percent: pct, bnbReceived, hash, approveHash,
  });
  // Mensaje de resultado y refresh del panel EN PARALELO (post-trade).
  const replyP = ctx.reply(text, extra)
    .then(() => tr.log('mensaje de resultado enviado a Telegram'));
  await refreshState(userId, state).catch(() => {});
  await rerenderByKey(ctx.telegram, key, state);
  await replyP.catch(() => {});
  tr.log('panel actualizado — FIN');
}

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const key = keyOf(ctx);

  // Cerrar/Eliminar: solo borran el mensaje, NO necesitan estado.
  // (El mensaje de compra/venta es aparte y no está en `states`.)
  if (data === 'close' || data === 'del') {
    states.delete(key);
    ctx.answerCbQuery().catch(() => {});
    return ctx.deleteMessage().catch(() => {});
  }

  const state = states.get(key);
  if (!state) {
    return ctx.answerCbQuery('Panel expirado, vuelve a pegar el contrato.', { show_alert: true });
  }

  try {
    if (data === 'side') {
      state.side = state.side === 'buy' ? 'sell' : 'buy';
      ctx.answerCbQuery().catch(() => {});
      return rerender(ctx, state);
    }

    if (data === 'refresh') {
      ctx.answerCbQuery('Actualizando...').catch(() => {});
      await refreshState(ctx.from.id, state, { forceBnb: true });
      return rerender(ctx, state);
    }

    if (data === 'slipBuy') {
      state.slipBuy = cycle(SLIPPAGE_PRESETS, state.slipBuy);
      await rerender(ctx, state);
      return ctx.answerCbQuery(`Slippage compra: ${state.slipBuy}%`);
    }

    if (data === 'slipSell') {
      state.slipSell = cycle(SLIPPAGE_PRESETS, state.slipSell);
      await rerender(ctx, state);
      return ctx.answerCbQuery(`Slippage venta: ${state.slipSell}%`);
    }

    if (data === 'gwei') {
      state.gwei = cycle(GWEI_PRESETS, state.gwei);
      await rerender(ctx, state);
      return ctx.answerCbQuery(`Gwei: ${state.gwei}`);
    }

    if (data === 'buyx') {
      pendingInput.set(ctx.from.id, { type: 'buy', key });
      await ctx.answerCbQuery();
      return ctx.reply('✏️ Envía la cantidad en *BNB* a comprar (ej: `0.37`)',
        { parse_mode: 'Markdown' });
    }

    if (data === 'sellx') {
      pendingInput.set(ctx.from.id, { type: 'sell', key });
      await ctx.answerCbQuery();
      return ctx.reply('✏️ Envía el *%* a vender (ej: `75`)',
        { parse_mode: 'Markdown' });
    }

    if (data.startsWith('buy:')) {
      const amount = data.slice(4);
      // Sin await: no bloqueamos el envío de la tx esperando a Telegram.
      ctx.answerCbQuery().catch(() => {});
      return doBuy(ctx, ctx.from.id, state, key, amount);
    }

    if (data.startsWith('sell:')) {
      const pct = Number(data.slice(5));
      ctx.answerCbQuery().catch(() => {});
      return doSell(ctx, ctx.from.id, state, key, pct);
    }

    return ctx.answerCbQuery();
  } catch (e) {
    console.error(e);
    return ctx.answerCbQuery(`❌ ${e.shortMessage || e.message}`.slice(0, 190), { show_alert: true });
  }
});

// Red de seguridad: ningún error tumba el proceso.
bot.catch((err, ctx) => {
  console.error('[bot.catch]', ctx?.updateType, err?.message || err);
  try {
    if (ctx?.callbackQuery) ctx.answerCbQuery('❌ Error temporal, reintenta.').catch(() => {});
  } catch { /* ignore */ }
});
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r?.message || r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));

// Calienta la conexión ANTES de arrancar (no en .then(): en Telegraf v4 esa
// promesa se resuelve al DETENER el bot, no al iniciarlo).
warmup()
  .then((bnb) => console.log(bnb
    ? `🔥 Conexión caliente — BNB $${bnb.toFixed(2)}`
    : '⚠️ Warmup falló (se reintenta al primer uso)'))
  .catch(() => {});

// Watcher de bloque en background: getCachedBlockNumber() = 0 RPC al comprar.
startBlockWatcher(300);

// dropPendingUpdates: ignora lo acumulado mientras estuvo apagado.
bot.launch({ dropPendingUpdates: true }).catch((e) =>
  console.error('[launch]', e?.message || e));
console.log('🤖 Bot en marcha');

// Salida limpia al PRIMER Ctrl+C.
function shutdown(sig) {
  console.log(`\n⏹  Deteniendo (${sig})...`);
  try { bot.stop(sig); } catch { /* ignore */ }
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
