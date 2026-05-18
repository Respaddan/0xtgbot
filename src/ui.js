import { Markup } from 'telegraf';
import { config } from './config.js';
import { estimateCostUsd } from './chain.js';

function fmtUsd(n) {
  if (!n || n <= 0) return '$0';
  if (n < 0.1) return '<$0.1';
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function fmtCost(n) {
  return n < 0.1 ? '<$0.1' : `$${n.toFixed(2)}`;
}

function fmtBnb(n) {
  if (!n) return '0';
  if (n < 0.0001) return n.toExponential(2);
  return Number(n.toFixed(5)).toString();
}

function fmtAmt(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return Number(n.toFixed(4)).toString();
}

const sign = (x) => (x >= 0 ? '+' : '');

// Panel "esqueleto" que se manda al instante; se rellena al llegar los datos.
export function renderSkeleton(addr) {
  return [
    `*Cargando…*  (BSC) — 🟢 COMPRA`,
    `\`${addr}\``,
    '',
    '*Pool Info*',
    `🦄 DEX: PANCAKE V2`,
    `🏭 Factory: ⏳`,
    `📊 Mcap: ⏳`,
    `💧 Liq: ⏳`,
    `⚖️ Cost: ⏳`,
  ].join('\n');
}

export function renderPanel(info, state) {
  const t = info.address;
  const costBuy = estimateCostUsd(state.gwei, info.bnbUsd, 'buy');
  const costSell = estimateCostUsd(state.gwei, info.bnbUsd, 'sell');

  const sideLabel = state.side === 'sell' ? '🔴 VENTA' : '🟢 COMPRA';

  const lines = [
    `*${info.name}* ($${info.symbol})  (BSC) — ${sideLabel}`,
    `\`${t}\``,
    '',
    '*Pool Info*',
    `🦄 DEX: PANCAKE V2`,
    `🏭 Factory: ${info.pairExists ? 'PancakeSwap' : 'Unknown ⚠️'}`,
    `📊 Mcap: ${fmtUsd(info.mcapUsd)}`,
    `💧 Liq: ${fmtUsd(info.liqUsd)} | ${info.liqPct.toFixed(2)}%`,
    `⚖️ Cost: B ${fmtCost(costBuy)} | S ${fmtCost(costSell)}`,
  ];

  // --- Wallet / posición ---
  lines.push('', `👛 ${config.walletLabel}: ${fmtBnb(info.walletBnb || 0)} BNB`);

  if (info.tokenBal > 0) {
    const valBnb = info.tokenBal * (info.priceBnb || 0);
    const valUsd = info.tokenBal * (info.priceUsd || 0);
    lines.push(`📦 ${info.symbol}: ${fmtAmt(info.tokenBal)} (≈ ${fmtBnb(valBnb)} BNB | ${fmtUsd(valUsd)})`);
  }

  const pnl = state.pnl;
  if (pnl && pnl.heldTracked > 0 && pnl.unrealPct != null) {
    const arrow = pnl.unrealPct >= 0 ? '🟢' : '🔴';
    lines.push(
      `📈 PnL: ${arrow} ${sign(pnl.unrealPct)}${pnl.unrealPct.toFixed(2)}% ` +
      `(${sign(pnl.unrealBnb)}${fmtBnb(pnl.unrealBnb)} BNB)`
    );
  }
  if (pnl && pnl.realizedBnb > 0) {
    lines.push(`💰 Realizado: ${fmtBnb(pnl.realizedBnb)} BNB`);
  }

  lines.push('', `[Gmgn](${config.links.gmgn(t)}) | [DeX](${config.links.dexscreener(t)}) | [Based](${config.links.based(t)})`);

  if (!info.pairExists) {
    lines.push('', '⚠️ No se encontró par en PancakeSwap V2 (WBNB/USDT/BUSD).');
  }
  return lines.join('\n');
}

// Mensaje de resultado de venta, con botón Cerrar.
// Extra (parse_mode + botón Cerrar) reutilizable para mensajes de resultado.
export function closeExtra() {
  return {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard([[btn('✖ Cerrar', 'close', 'danger')]]),
  };
}

export function renderSellResult({ symbol, percent, bnbReceived, hash, approveHash }) {
  const lines = [];
  if (approveHash) lines.push(`🔓 Approve: [Tx](https://bscscan.com/tx/${approveHash})`);
  lines.push(
    `🔴 *Venta ${percent}% de ${symbol}* ejecutada`,
    `💵 Recibido: *${fmtBnb(bnbReceived)} BNB*`,
    `[Tx](https://bscscan.com/tx/${hash})`
  );
  return { text: lines.join('\n'), extra: closeExtra() };
}

// Botón con color nativo (Bot API 9.4): style = success|danger|primary.
// Telegraf no conoce `style`, así que lo añadimos al objeto del botón.
function btn(text, data, style) {
  const b = Markup.button.callback(text, data);
  if (style) b.style = style;
  return b;
}

// Botón de operación: si hay emoji custom (logo BNB) lo usa como ícono;
// si no, cae al emoji estándar como prefijo del texto.
function opBtn(label, data, style) {
  const ic = config.iconCustomEmojiId;
  if (ic) {
    const b = btn(label, data, style);
    b.icon_custom_emoji_id = ic;
    return b;
  }
  return btn(`${config.buyEmoji} ${label}`, data, style);
}

export function renderKeyboard(state) {
  const sell = state.side === 'sell';

  const rows = [];

  // Cambiar lado: SOLO el símbolo (verde→ir a compra / rojo→ir a venta)
  // + refrescar en color original de Telegram (sin estilo).
  rows.push([
    sell
      ? btn('↔️', 'side', 'success')
      : btn('↔️', 'side', 'danger'),
    btn('🔄', 'refresh'),
  ]);

  // Botones de operación (3 por fila): compra VERDE, venta ROJO.
  const opCells = sell
    ? config.sellPercents.map((p) => opBtn(`${p}%`, `sell:${p}`, 'danger'))
    : config.buyAmounts.map((a) => opBtn(`${a}`, `buy:${a}`, 'success'))
        .concat(opBtn('X/%', 'buyx', 'success'));
  for (let i = 0; i < opCells.length; i += 3) {
    rows.push(opCells.slice(i, i + 3));
  }

  // Slippage compra / venta (color original de Telegram)
  rows.push([
    btn(`📊 B Slip ${state.slipBuy}%`, 'slipBuy'),
    btn(`📈 S Slip ${state.slipSell}%`, 'slipSell'),
  ]);

  // Gwei (color original) + eliminar (solo cesta, rojo)
  rows.push([
    btn(`⛽ Gwei: ${state.gwei}`, 'gwei'),
    btn('🗑', 'del', 'danger'),
  ]);

  return Markup.inlineKeyboard(rows);
}
