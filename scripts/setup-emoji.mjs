// Setup ÚNICO: crea un set de emoji custom (logo BNB) a nombre del dueño,
// para usar icon_custom_emoji_id en los botones. Correr: npm run setup:emoji
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Jimp } from 'jimp';

const TOKEN = process.env.BOT_TOKEN;
const OWNER = Number(process.env.OWNER_ID);
if (!TOKEN || !OWNER) {
  console.error('Falta BOT_TOKEN u OWNER_ID en .env');
  process.exit(1);
}
const API = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

async function tg(method, body) {
  const r = await fetch(API(method), body);
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}

// Carpeta de imágenes locales: usa la PRIMERA imagen que encuentre ahí
// (icon.png, bsc.png, lo que sea). También puedes forzar con ICON_FILE.
const ASSETS_DIR = new URL('../assets/', import.meta.url);

function findLocalIcon() {
  if (process.env.ICON_FILE) {
    const f = new URL(`../${process.env.ICON_FILE}`, import.meta.url);
    return existsSync(f) ? f : null;
  }
  if (!existsSync(ASSETS_DIR)) return null;
  const imgs = readdirSync(ASSETS_DIR)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => new URL(f, ASSETS_DIR))
    .sort((a, b) => statSync(fileURLToPath(b)).mtimeMs - statSync(fileURLToPath(a)).mtimeMs);
  return imgs.length ? imgs[0] : null; // la más reciente
}

// Fallback si no hay archivo local.
const LOGOS = [
  'https://cryptologos.cc/logos/bnb-bnb-logo.png',
  'https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
  'https://s2.coinmarketcap.com/static/img/coins/200x200/1839.png',
];

// Tamaño interno del glifo dentro del lienzo 100x100. Más chico = más margen
// (se ve más pequeño/armonioso en el botón). 100 = sin margen.
const INNER = Number(process.env.ICON_INNER_SIZE || 78);

async function loadSource() {
  const local = findLocalIcon();
  if (local) {
    console.log('Usando imagen local:', decodeURIComponent(local.pathname.split('/').pop()));
    return await Jimp.read(Buffer.from(readFileSync(local)));
  }
  for (const url of LOGOS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      console.log('Usando logo descargado:', url);
      return await Jimp.read(Buffer.from(await res.arrayBuffer()));
    } catch { /* siguiente */ }
  }
  throw new Error('No hay assets/icon.png ni se pudo descargar un logo');
}

async function getIcon100() {
  const src = await loadSource();
  src.resize({ w: INNER, h: INNER });
  // Lienzo 100x100 transparente con el glifo centrado (margen = más pequeño).
  const canvas = new Jimp({ width: 100, height: 100, color: 0x00000000 });
  const off = Math.round((100 - INNER) / 2);
  canvas.composite(src, off, off);
  return await canvas.getBuffer('image/png');
}

function upsertEnv(key, value) {
  const path = new URL('../.env', import.meta.url);
  let txt = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, 'm').test(txt)) {
    txt = txt.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  } else {
    txt += (txt.endsWith('\n') || txt === '' ? '' : '\n') + line + '\n';
  }
  writeFileSync(path, txt);
}

(async () => {
  const me = await tg('getMe');
  const username = me.username;
  console.log('Bot:', '@' + username);

  const png = await getIcon100();
  console.log(`Ícono listo (100x100 PNG, glifo ${INNER}px con margen).`);

  const name = `bnb_${Date.now().toString(36)}_by_${username}`;

  const fd = new FormData();
  fd.append('user_id', String(OWNER));
  fd.append('name', name);
  fd.append('title', 'BNB Chain Icons');
  fd.append('sticker_type', 'custom_emoji');
  fd.append('stickers', JSON.stringify([
    { sticker: 'attach://logo', format: 'static', emoji_list: ['🟡'] },
  ]));
  fd.append('logo', new Blob([png], { type: 'image/png' }), 'bnb.png');

  await tg('createNewStickerSet', { method: 'POST', body: fd });
  const set = await tg(`getStickerSet?name=${name}`);
  const id = set.stickers[0].custom_emoji_id;

  upsertEnv('ICON_CUSTOM_EMOJI_ID', id);
  console.log('\n✅ Listo. ICON_CUSTOM_EMOJI_ID =', id);
  console.log('Guardado en .env. Reinicia el bot (npm start).');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
