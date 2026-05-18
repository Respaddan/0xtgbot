import 'dotenv/config';

export const config = {
  botToken: process.env.BOT_TOKEN,
  privateKey: process.env.PRIVATE_KEY,

  // Seguridad: solo estos IDs de Telegram pueden usar el bot.
  // OWNER_ID = tú (usa la PRIVATE_KEY del .env).
  // ALLOWED_USER_IDS = otros autorizados (cada uno con SU propia wallet vía /setwallet).
  ownerId: process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null,
  allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
    .split(',').map((s) => Number(s.trim())).filter(Boolean),

  // Clave para cifrar en disco las wallets de otros usuarios.
  walletEncKey: process.env.WALLET_ENC_KEY || '',

  // Lecturas por WSS, envío de tx por HTTP (según indicación del usuario)
  wssRpc: process.env.WSS_RPC || 'wss://bsc-rpc.publicnode.com',
  httpRpc: process.env.HTTP_RPC || 'https://bsc.rpc.blxrbdn.com',
  // Respaldo de LECTURA si el WSS se cuelga (publicnode también sirve por https)
  httpReadRpc: process.env.HTTP_READ_RPC || 'https://bsc-rpc.publicnode.com',

  chainId: 56,

  // Direcciones BSC / PancakeSwap V2
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  PANCAKE_V2_FACTORY: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
  PANCAKE_V2_ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  // Hash del init code del par V2 -> permite calcular la dirección del par
  // por CREATE2 sin preguntar al Factory (ahorra 3 llamadas RPC).
  PANCAKE_INIT_CODE_HASH: '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5',
  MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11',

  DEAD_ADDRESS: '0x000000000000000000000000000000000000dEaD',

  // Valores por defecto del panel
  defaults: {
    slippageBuy: 10,   // %
    slippageSell: 10,  // %
    gwei: 0.15,
  },

  // Etiqueta de la wallet mostrada en el panel (como "W1" en otros bots)
  walletLabel: process.env.WALLET_LABEL || 'W1',

  // Botones de compra (BNB) y venta (% del balance)
  buyAmounts: ['0.1', '0.2', '0.25', '0.5', '1'],
  sellPercents: [1, 5, 10, 25, 50, 100],
  buyEmoji: '💎',
  // ID de emoji custom (logo BNB) generado por `npm run setup:emoji`.
  iconCustomEmojiId: process.env.ICON_CUSTOM_EMOJI_ID || '',

  // Plantillas de enlaces externos
  links: {
    gmgn: (t) => `https://gmgn.ai/bsc/token/${t}`,
    dexscreener: (t) => `https://dexscreener.com/bsc/${t}`,
    based: (t) => `https://basedbot.app/token/bsc/${t}`,
  },
};

if (!config.botToken) console.warn('[config] Falta BOT_TOKEN en .env');
if (!config.privateKey) console.warn('[config] Falta PRIVATE_KEY en .env (tus compras/ventas fallarán)');
if (!config.ownerId) console.warn('[config] Falta OWNER_ID en .env — el bot NO responderá a nadie hasta configurarlo');
