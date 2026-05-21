import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';
import { config } from './config.js';
import { getTokenInfo, withTimeout, resetReadProvider, warmup, startBlockWatcher, getWriteProvider, getMultiWalletBalances } from './chain.js';
import { executeBuy, executeSell } from './swap.js';
import { renderPanel, renderKeyboard, renderSellResult, closeExtra,
         renderWalletsPanel, renderWalletsKeyboard,
         renderPreferredPanel, renderPreferredKeyboard } from './ui.js';
import { authMiddleware, isOwner } from './auth.js';
import { getSignerFor, getSignerForIndex, setUserWallet, removeUserWallet, getUserAddress,
         listWallets, setActiveWallet, addWallet, createNewWallet,
         exportPrivateKey } from './wallets.js';
import { getPosition, recordBuy, recordSell, resetPosition, computePnl } from './positions.js';
import { makeTrace } from './trace.js';
import { runLatencyProbe } from './diag.js';
import readline from 'node:readline';
import https from 'node:https';

// Dirección de wallet del usuario para mostrar balances (o null si no tiene).
function walletOf(userId) {
  try { return getUserAddress(userId); } catch { return null; }
}

// Carga info del token + balances de la wallet + PnL, y lo deja en state.
// Construye state.walletsInfo SOLO con lo que ya está en cache (sin RPC).
// Las wallets activas no cacheadas se omiten temporalmente del bloque info.
function buildWalletsInfoFromCache(state) {
  const idxs = [...(state.activeWallets || [])].sort((a, b) => a - b)
    .filter((i) => i < (state.wallets?.length || 0));
  const cache = state.walletCache || new Map();
  state.walletsInfo = idxs.map((i) => {
    const w = state.wallets[i];
    const c = cache.get(w.address.toLowerCase());
    return c ? { label: w.label, address: w.address, bnb: c.bnb, tokenBal: c.tokenBal, pnl: c.pnl } : null;
  }).filter(Boolean);
}

// Fetch incremental: solo trae balances de las wallets activas que NO estén en
// cache (o si force=true, todas). 1 multicall por las faltantes.
async function updateActiveWalletsInfo(state, userId, { force = false } = {}) {
  if (!state.walletCache) state.walletCache = new Map();
  const idxs = [...(state.activeWallets || [])].sort((a, b) => a - b)
    .filter((i) => i < (state.wallets?.length || 0));
  if (!idxs.length) { state.walletsInfo = []; return; }

  const addrs = idxs.map((i) => state.wallets[i].address);
  const toFetch = force ? addrs : addrs.filter((a) => !state.walletCache.has(a.toLowerCase()));
  if (toFetch.length) {
    const bals = await getMultiWalletBalances(toFetch, state.token, state.info.decimals)
      .catch(() => toFetch.map((a) => ({ address: a, bnb: 0, tokenBal: 0 })));
    const now = Date.now();
    for (const b of bals) {
      const p = getPosition(userId, b.address, state.token);
      const pnl = p ? computePnl(p, state.info.priceBnb) : null;
      state.walletCache.set(b.address.toLowerCase(), { bnb: b.bnb, tokenBal: b.tokenBal, pnl, ts: now });
    }
  }
  buildWalletsInfoFromCache(state);
}

async function refreshState(userId, state, { forceBnb = false } = {}) {
  const wallet = walletOf(userId);
  state.wallet = wallet;
  state.info = await loadInfo(state.token, { forceBnb, wallet });

  // Hasta 3 wallets visibles en el panel (W1/W2/W3). La activa por defecto.
  const { list, active } = listWallets(userId);
  state.wallets = list.slice(0, 3);
  if (!(state.activeWallets instanceof Set)) {
    const def = state.wallets.length ? Math.min(active, state.wallets.length - 1) : 0;
    state.activeWallets = new Set(state.wallets.length ? [def] : []);
  } else {
    for (const i of [...state.activeWallets]) {
      if (i >= state.wallets.length) state.activeWallets.delete(i);
    }
    if (!state.activeWallets.size && state.wallets.length) state.activeWallets.add(0);
  }

  // Refresh "completo": fuerza re-fetch de TODAS las wallets activas y
  // actualiza el cache.
  await updateActiveWalletsInfo(state, userId, { force: true });

  // PnL "principal" del panel (fallback).
  const pos = wallet ? getPosition(userId, wallet, state.token) : null;
  state.pnl = pos ? computePnl(pos, state.info.priceBnb) : null;
  return state.info;
}

if (!config.botToken) {
  console.error('Falta BOT_TOKEN en .env. Cópialo desde @BotFather.');
  process.exit(1);
}

// Agente HTTPS con keep-alive para Telegraf → reutiliza la conexión a
// api.telegram.org en cada llamada → evita el handshake TCP+TLS por request
// (~100-200ms menos por cada sendMessage/edit/answerCbQuery).
const tgAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const bot = new Telegraf(config.botToken, {
  handlerTimeout: 60_000,
  telegram: { agent: tgAgent },
});

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

const showWallet = (ctx) => {
  try {
    const addr = getUserAddress(ctx.from.id);
    return addr
      ? ctx.reply(`Tu wallet:\n\`${addr}\``, { parse_mode: 'Markdown' })
      : ctx.reply('No tienes wallet configurada. Usa /setwallet <private_key>');
  } catch (e) {
    return ctx.reply(`❌ ${e.message}`);
  }
};
bot.command('mywallet', showWallet);
bot.command('wallet', showWallet);

bot.command('balance', async (ctx) => {
  const addr = walletOf(ctx.from.id);
  if (!addr) return ctx.reply('No tienes wallet configurada. Usa /setwallet <private_key>');
  try {
    const wei = await getWriteProvider().getBalance(addr);
    const bnb = Number(ethers.formatEther(wei));
    return ctx.reply(
      `💼 *Balance*\n` +
      `\`${addr}\`\n\n` +
      `🟡 BNB: *${bnb.toFixed(5)}*\n` +
      `🔷 ETH: _(próximamente, al añadir ETH chain)_`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    return ctx.reply(`❌ No pude leer el balance: ${e.shortMessage || e.message}`);
  }
});

bot.command('removewallet', (ctx) => {
  if (isOwner(ctx.from.id)) return ctx.reply('La wallet del dueño se gestiona en el .env.');
  return ctx.reply(removeUserWallet(ctx.from.id) ? '🗑 Wallet eliminada.' : 'No tenías wallet guardada.');
});

// --- Panel /wallets ---
async function fetchWalletBalances(list) {
  const p = getWriteProvider();
  return Promise.all(list.map((w) =>
    p.getBalance(w.address).then((wei) => Number(ethers.formatEther(wei))).catch(() => null)
  ));
}

async function sendWalletsPanel(ctx) {
  const { list, active } = listWallets(ctx.from.id);
  const balances = await fetchWalletBalances(list).catch(() => []);
  return ctx.reply(renderWalletsPanel({ list, active, balances }),
    { parse_mode: 'Markdown', ...renderWalletsKeyboard() });
}

async function editWalletsPanel(ctx) {
  const { list, active } = listWallets(ctx.from.id);
  const balances = await fetchWalletBalances(list).catch(() => []);
  return ctx.editMessageText(renderWalletsPanel({ list, active, balances }),
    { parse_mode: 'Markdown', ...renderWalletsKeyboard() }).catch(() => {});
}

bot.command('wallets', sendWalletsPanel);

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

  // --- Import de private key (botón 🔑 Import a wallet) ---
  if (p.type === 'import_pk') {
    pendingInput.delete(ctx.from.id);
    // Borramos el mensaje con la PK del chat lo antes posible.
    await ctx.deleteMessage().catch(() => {});
    try {
      const w = addWallet(ctx.from.id, (ctx.message.text || '').trim());
      await ctx.reply(`✅ Wallet *${w.label}* importada y activada\n\`${w.address}\``,
        { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply(`❌ ${e.shortMessage || e.message}`);
    }
    return;
  }

  // --- Cantidad personalizada (botón X/%) ---
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

// Devuelve los índices ordenados de las wallets activas del panel.
function activeIdxs(state) {
  const set = state.activeWallets instanceof Set ? state.activeWallets : new Set([0]);
  return [...set].sort((a, b) => a - b).filter((i) => i < (state.wallets?.length || 0));
}

async function doBuy(ctx, userId, state, key, amount) {
  const idxs = activeIdxs(state);
  const labels = idxs.map((i) => state.wallets[i].label).join('+');
  const tr = makeTrace(`COMPRA ${amount} BNB ${state.info?.symbol || ''} [${labels}]`);

  // Compra en PARALELO con cada wallet activa. allSettled para que el fallo
  // de una no tire a las demás.
  const results = await Promise.allSettled(idxs.map(async (i) => {
    const { signer, label, address } = getSignerForIndex(userId, i);
    const r = await executeBuy(signer, state.info, String(amount), state.slipBuy, state.gwei, tr);
    recordBuy(userId, address, state.token, r.bnbSpent, r.tokensReceived);
    return { label, address, ...r };
  }));

  const lines = [`🟢 *Compra ejecutada* (${idxs.length} wallet${idxs.length > 1 ? 's' : ''})`];
  results.forEach((res, k) => {
    const lbl = state.wallets[idxs[k]].label;
    if (res.status === 'fulfilled') {
      const r = res.value;
      lines.push(
        `\n*${lbl}*  •  💸 ${amount} BNB → 📦 ${r.tokensReceived} ${state.info.symbol}`,
        `[Tx](https://bscscan.com/tx/${r.hash})` +
        (r.approveHash ? ` · 🔓 Approve: [Tx](https://bscscan.com/tx/${r.approveHash})` : '')
      );
    } else if (res.reason?.code === 'SIMULATED_REVERT') {
      const txLink = res.reason.hash ? `[Tx](https://bscscan.com/tx/${res.reason.hash})` : '';
      const ahorro = res.reason.cancelled ? ' (gas ahorrado: no se mandó al fallback)' : '';
      lines.push(
        `\n*${lbl}*  •  ❌ *Compra reverteó*${ahorro}`,
        `Causas probables:`,
        `  • Buy tax > ${state.slipBuy}% (sube el slippage)`,
        `  • Trading aún no abierto / anti-bot`,
        `  • MaxTx / MaxWallet del token`,
        `  • Honeypot`,
        txLink
      );
    } else {
      // Sanitizamos: envolvemos en `...` para que Markdown ignore `[](`*_~
      // (caracteres que vienen en mensajes de relays/RPCs y rompen el parser).
      const _err = (res.reason?.shortMessage || res.reason?.message || res.reason || '')
        .toString().slice(0, 180).replace(/`/g, "'");
      lines.push(`\n*${lbl}*  •  ❌ \`${_err}\``);
    }
  });

  const replyP = ctx.reply(lines.join('\n'), closeExtra())
    .then(() => tr.log('mensaje de resultado enviado a Telegram'));
  await refreshState(userId, state).catch(() => {});
  await rerenderByKey(ctx.telegram, key, state);
  await replyP.catch(() => {});
  tr.log('panel actualizado — FIN');
}

async function doSell(ctx, userId, state, key, pct) {
  const idxs = activeIdxs(state);
  const labels = idxs.map((i) => state.wallets[i].label).join('+');
  const tr = makeTrace(`VENTA ${pct}% ${state.info?.symbol || ''} [${labels}]`);

  const results = await Promise.allSettled(idxs.map(async (i) => {
    const { signer, label, address } = getSignerForIndex(userId, i);
    const r = await executeSell(signer, state.info, pct, state.slipSell, state.gwei, tr);
    recordSell(userId, address, state.token, r.tokensSold, r.bnbReceived);
    if (r.soldAll) resetPosition(userId, address, state.token);
    return { label, address, ...r };
  }));

  const lines = [`🔴 *Venta ${pct}%* (${idxs.length} wallet${idxs.length > 1 ? 's' : ''})`];
  results.forEach((res, k) => {
    const lbl = state.wallets[idxs[k]].label;
    if (res.status === 'fulfilled') {
      const r = res.value;
      lines.push(
        `\n*${lbl}*  •  💵 +${Number(r.bnbReceived).toFixed(5)} BNB`,
        `[Tx](https://bscscan.com/tx/${r.hash})` +
        (r.approveHash ? ` · 🔓 Approve: [Tx](https://bscscan.com/tx/${r.approveHash})` : '')
      );
    } else if (res.reason?.code === 'SIMULATED_REVERT') {
      const txLink = res.reason.hash ? `[Tx](https://bscscan.com/tx/${res.reason.hash})` : '';
      const ahorro = res.reason.cancelled ? ' (gas ahorrado: no se mandó al fallback)' : '';
      lines.push(
        `\n*${lbl}*  •  ❌ *Venta reverteó*${ahorro}`,
        `Causas probables:`,
        `  • Sell tax > ${state.slipSell}% (sube el slippage)`,
        `  • Honeypot (el token no permite vender)`,
        `  • Cooldown / anti-bot del token`,
        `  • Allowance insuficiente`,
        txLink
      );
    } else {
      // Sanitizamos: envolvemos en `...` para que Markdown ignore `[](`*_~
      // (caracteres que vienen en mensajes de relays/RPCs y rompen el parser).
      const _err = (res.reason?.shortMessage || res.reason?.message || res.reason || '')
        .toString().slice(0, 180).replace(/`/g, "'");
      lines.push(`\n*${lbl}*  •  ❌ \`${_err}\``);
    }
  });

  const replyP = ctx.reply(lines.join('\n'), closeExtra())
    .then(() => tr.log('mensaje de resultado enviado a Telegram'));
  await refreshState(userId, state).catch(() => {});
  await rerenderByKey(ctx.telegram, key, state);
  await replyP.catch(() => {});
  tr.log('panel actualizado — FIN');
}

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const key = keyOf(ctx);

  // --- Acciones del panel de wallets (w:*) ---
  if (data === 'w:close') {
    ctx.answerCbQuery().catch(() => {});
    return ctx.deleteMessage().catch(() => {});
  }
  if (data === 'w:refresh') {
    ctx.answerCbQuery('Actualizando…').catch(() => {});
    return editWalletsPanel(ctx);
  }
  if (data === 'w:new') {
    try {
      const w = createNewWallet(ctx.from.id);
      ctx.answerCbQuery(`Nueva wallet ${w.label} creada`).catch(() => {});
      await editWalletsPanel(ctx);
      // Mostramos la PK UNA vez con aviso; el usuario debe guardarla.
      return ctx.reply(
        `🆕 *Nueva wallet ${w.label}*\n` +
        `Dirección: \`${w.address}\`\n\n` +
        `🔐 *Private key (guárdala YA, no se vuelve a mostrar):*\n` +
        `\`${w.pk}\`\n\n` +
        `⚠️ Borra este mensaje cuando la hayas guardado.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      return ctx.answerCbQuery(`❌ ${e.message}`.slice(0, 190), { show_alert: true });
    }
  }
  if (data === 'w:import') {
    pendingInput.set(ctx.from.id, { type: 'import_pk' });
    ctx.answerCbQuery().catch(() => {});
    return ctx.reply('🔑 Envíame la *private key* a importar (mensaje se borra solo).',
      { parse_mode: 'Markdown' });
  }
  if (data === 'w:remove') {
    // 2-tap confirm: la 1ª pulsación pide confirmación, la 2ª ejecuta.
    ctx.answerCbQuery().catch(() => {});
    return ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: '⚠️ Sí, eliminar la activa', callback_data: 'w:remove:yes' }],
        [{ text: '« Cancelar', callback_data: 'w:refresh' }],
      ],
    }).catch(() => {});
  }
  if (data === 'w:remove:yes') {
    const ok = removeUserWallet(ctx.from.id);
    ctx.answerCbQuery(ok ? 'Eliminada' : 'No había wallet').catch(() => {});
    return editWalletsPanel(ctx);
  }
  if (data === 'w:pref') {
    const { list, active } = listWallets(ctx.from.id);
    ctx.answerCbQuery().catch(() => {});
    if (!list.length) return editWalletsPanel(ctx);
    return ctx.editMessageText(renderPreferredPanel(list),
      { parse_mode: 'Markdown', ...renderPreferredKeyboard(list, active) }).catch(() => {});
  }
  if (data.startsWith('w:pref:')) {
    const idx = Number(data.slice(7));
    try {
      setActiveWallet(ctx.from.id, idx);
      ctx.answerCbQuery('Activa cambiada ✅').catch(() => {});
    } catch (e) {
      ctx.answerCbQuery(`❌ ${e.message}`.slice(0, 190)).catch(() => {});
    }
    return editWalletsPanel(ctx);
  }
  // Paso 1: sub-panel para ELEGIR qué wallet exportar.
  if (data === 'w:export') {
    ctx.answerCbQuery().catch(() => {});
    const { list } = listWallets(ctx.from.id);
    if (!list.length) {
      return ctx.editMessageText('No tienes wallets para exportar.',
        { parse_mode: 'Markdown', ...renderWalletsKeyboard() }).catch(() => {});
    }
    const rows = [];
    for (let i = 0; i < list.length; i += 2) {
      rows.push(list.slice(i, i + 2).map((w, k) => ({
        text: `📤 ${w.label}`,
        callback_data: `w:exp:${i + k}`,
      })));
    }
    rows.push([{ text: '« Volver', callback_data: 'w:refresh' }]);
    return ctx.editMessageText(
      '*📤 Exportar private key*\n\nElige qué wallet quieres exportar:',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
    ).catch(() => {});
  }

  // Paso 2: confirmación específica de la wallet elegida (w:exp:N).
  if (data.startsWith('w:exp:') && !data.endsWith(':yes')) {
    const idx = Number(data.slice(6));
    const { list } = listWallets(ctx.from.id);
    if (!Number.isInteger(idx) || !list[idx]) {
      return ctx.answerCbQuery('Wallet inválida', { show_alert: true });
    }
    ctx.answerCbQuery().catch(() => {});
    return ctx.editMessageText(
      `⚠️ *Exportar private key de ${list[idx].label}*\n` +
      `\`${list[idx].address}\`\n\n` +
      `Vas a mostrar la PK en este chat. Quien vea ese mensaje podrá controlar la wallet.\n` +
      `Se autoborra en 60s, pero mejor cópiala y bórrala tú al toque.\n\n¿Continuar?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚠️ Sí, mostrar la PK', callback_data: `w:exp:${idx}:yes` }],
            [{ text: '« Volver', callback_data: 'w:export' }],
          ],
        },
      }
    ).catch(() => {});
  }

  // Paso 3: realmente mostrar la PK (w:exp:N:yes) y autoborrar.
  if (data.startsWith('w:exp:') && data.endsWith(':yes')) {
    const idx = Number(data.slice(6, -4));
    ctx.answerCbQuery().catch(() => {});
    try {
      const pk = exportPrivateKey(ctx.from.id, idx);
      if (!pk) {
        await ctx.reply('❌ No pude leer la PK de esa wallet.');
        return editWalletsPanel(ctx);
      }
      const { list } = listWallets(ctx.from.id);
      const lbl = list[idx]?.label || `W${idx + 1}`;
      const sent = await ctx.reply(
        `🔐 *Private key de ${lbl}*\n\`${pk}\`\n\n⚠️ *Cópiala y borra este mensaje.* Se autoborra en 60s.`,
        { parse_mode: 'Markdown' }
      );
      setTimeout(() => {
        ctx.telegram.editMessageText(
          sent.chat.id, sent.message_id, undefined,
          `🔐 *Private key de ${lbl}*\n\`${pk}\`\n\n⚠️ *Borra esto.* Se autoborra en ~30s.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }, 30_000);
      setTimeout(() => {
        ctx.telegram.deleteMessage(sent.chat.id, sent.message_id).catch(() => {});
      }, 60_000);
    } catch (e) {
      await ctx.reply(`❌ ${e.shortMessage || e.message}`);
    }
    return editWalletsPanel(ctx);
  }
  if (data === 'w:txfer') {
    return ctx.answerCbQuery('🚀 Transfer Token — próximamente (lo haré como bloque dedicado).',
      { show_alert: true });
  }

  // Toggle de wallet activa en el panel principal (wsel:N).
  if (data.startsWith('wsel:')) {
    const idx = Number(data.slice(5));
    const state = states.get(key);
    if (!state) return ctx.answerCbQuery('Panel expirado', { show_alert: true });
    if (!(state.activeWallets instanceof Set)) state.activeWallets = new Set([0]);
    if (state.activeWallets.has(idx)) {
      if (state.activeWallets.size > 1) state.activeWallets.delete(idx);
      else {
        return ctx.answerCbQuery('Debe quedar al menos 1 wallet activa', { show_alert: true });
      }
    } else {
      state.activeWallets.add(idx);
    }
    ctx.answerCbQuery().catch(() => {});

    // 1) Render INMEDIATO con lo que ya hay en cache (teclado se ve al instante).
    buildWalletsInfoFromCache(state);
    rerender(ctx, state).catch(() => {});

    // 2) Fetch en BACKGROUND solo de las wallets faltantes (no re-pide las que
    //    ya tenemos). Cuando vuelve, re-renderiza el panel con su info llena.
    updateActiveWalletsInfo(state, ctx.from.id)
      .then(() => rerenderByKey(ctx.telegram, key, state))
      .catch(() => {});
    return;
  }

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

// Descripción + menú de comandos (programático, sin BotFather).
(async () => {
  try {
    await bot.telegram.setMyShortDescription('Trading rápido en BSC (PancakeSwap) — pega un CA y opera.');
    await bot.telegram.setMyDescription('cosas grandes y ocultas que tu no conoces');
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Iniciar / cómo usar' },
      { command: 'wallets', description: 'Gestionar tus wallets (multi-wallet)' },
      { command: 'balance', description: 'Ver balance de tu wallet activa (BNB)' },
      { command: 'wallet', description: 'Ver tu dirección activa' },
    ]);
    console.log('📋 Descripción y menú de comandos configurados');
  } catch (e) {
    console.warn('[setup-bot] no se pudo configurar descripción/menú:', e?.message || e);
  }
})();

// dropPendingUpdates: ignora lo acumulado mientras estuvo apagado.
bot.launch({ dropPendingUpdates: true }).catch((e) =>
  console.error('[launch]', e?.message || e));
console.log('🤖 Bot en marcha');

// Consola interactiva: comandos por stdin (solo si es terminal).
if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin });
  console.log('💡 Tip consola: escribe  l  + Enter → probar latencias  |  q + Enter → salir  |  ? = ayuda');
  let probing = false;
  rl.on('line', async (raw) => {
    const cmd = raw.trim().toLowerCase();
    if (!cmd) return;
    if (cmd === 'l' || cmd === 'latency' || cmd === 'ping') {
      if (probing) return console.log('⏳ probe en curso, espera…');
      probing = true;
      try { await runLatencyProbe({ telegram: bot.telegram, ownerId: config.ownerId }); }
      finally { probing = false; }
    } else if (cmd === '?' || cmd === 'help' || cmd === 'h') {
      console.log('Comandos consola: l|latency|ping = probar latencias · q|quit = salir · ? = ayuda');
    } else if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
      shutdown('user');
    } else {
      console.log(`(consola) comando desconocido: "${cmd}" — escribe ? para ver opciones`);
    }
  });
}

// Salida limpia al PRIMER Ctrl+C.
function shutdown(sig) {
  console.log(`\n⏹  Deteniendo (${sig})...`);
  try { bot.stop(sig); } catch { /* ignore */ }
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
