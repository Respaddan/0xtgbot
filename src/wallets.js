import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { ethers } from 'ethers';
import { config } from './config.js';
import { isOwner } from './auth.js';
import { getWriteProvider } from './chain.js';

const STORE = new URL('../wallets.json', import.meta.url);

// --- Cifrado AES-256-GCM de las private keys ---
function deriveKey(salt) {
  if (!config.walletEncKey) {
    throw new Error('Falta WALLET_ENC_KEY en .env para guardar wallets');
  }
  return scryptSync(config.walletEncKey, salt, 32);
}
function encryptPk(pk) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(pk, 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: enc.toString('hex'),
  };
}
function decryptPk(rec) {
  const key = deriveKey(Buffer.from(rec.salt, 'hex'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(rec.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(rec.data, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

// --- Persistencia ---
function loadRaw() {
  if (!existsSync(STORE)) return {};
  try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function saveRaw(o) {
  writeFileSync(STORE, JSON.stringify(o, null, 2), { mode: 0o600 });
}

// Compat: formato viejo = wallets[userId] es directamente un record cifrado.
// Nuevo = wallets[userId] = { active: N, list: [{label, address, enc}] }
function getUserStore(userId) {
  const raw = loadRaw();
  const u = raw[String(userId)];
  if (!u) return { active: 0, list: [] };
  if (u.list && Array.isArray(u.list)) return u; // ya nuevo formato
  // Migración: formato viejo (record cifrado directo) → list con W1
  try {
    const pk = decryptPk(u);
    const address = new ethers.Wallet(pk).address;
    return { active: 0, list: [{ label: 'W1', address, enc: u }] };
  } catch {
    return { active: 0, list: [] };
  }
}
function saveUserStore(userId, store) {
  const raw = loadRaw();
  raw[String(userId)] = store;
  saveRaw(raw);
}

function normalizePk(pk) {
  const v = String(pk).trim();
  const withPrefix = v.startsWith('0x') ? v : `0x${v}`;
  return new ethers.Wallet(withPrefix).privateKey; // lanza si inválida
}

function nextLabel(list) {
  // W1, W2, W3… reutiliza huecos.
  const used = new Set(list.map((w) => w.label));
  for (let i = 1; i <= 999; i++) {
    const lbl = `W${i}`;
    if (!used.has(lbl)) return lbl;
  }
  return `W${list.length + 1}`;
}

// La "wallet del dueño desde .env" virtualizada como W1 si no hay lista todavía.
function ownerEnvWallet() {
  if (!config.privateKey) return null;
  const pk = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
  return { label: 'W1', address: new ethers.Wallet(pk).address, pk };
}

// --- API pública ---

/** Lista de wallets del usuario (objetos {label, address}). El dueño ve su
 *  .env como W1 si todavía no ha creado/importado otras. */
export function listWallets(userId) {
  const s = getUserStore(userId);
  if (s.list.length) return { active: s.active | 0, list: s.list.map(({ label, address }) => ({ label, address })) };
  if (isOwner(userId)) {
    const w = ownerEnvWallet();
    return { active: 0, list: w ? [{ label: w.label, address: w.address }] : [] };
  }
  return { active: 0, list: [] };
}

export function getActiveWallet(userId) {
  const s = getUserStore(userId);
  if (s.list.length) {
    const w = s.list[Math.min(s.active | 0, s.list.length - 1)];
    return { label: w.label, address: w.address, pk: decryptPk(w.enc) };
  }
  if (isOwner(userId)) return ownerEnvWallet();
  return null;
}

export function getUserAddress(userId) {
  const w = getActiveWallet(userId);
  return w ? w.address : null;
}

export function setActiveWallet(userId, index) {
  const s = getUserStore(userId);
  if (!s.list.length && isOwner(userId)) return; // solo .env, no hay nada que cambiar
  if (index < 0 || index >= s.list.length) throw new Error('Índice de wallet inválido');
  s.active = index;
  saveUserStore(userId, s);
}

export function addWallet(userId, pk) {
  const clean = normalizePk(pk);
  const address = new ethers.Wallet(clean).address;
  const s = getUserStore(userId);
  // Si el dueño todavía no tiene lista, materializamos su .env como W1 primero
  // para no perderla y conservar el orden.
  if (!s.list.length && isOwner(userId)) {
    const env = ownerEnvWallet();
    if (env) s.list.push({ label: 'W1', address: env.address, enc: encryptPk(env.pk) });
  }
  if (s.list.some((w) => w.address.toLowerCase() === address.toLowerCase())) {
    throw new Error('Esa wallet ya está en tu lista');
  }
  const label = nextLabel(s.list);
  s.list.push({ label, address, enc: encryptPk(clean) });
  s.active = s.list.length - 1; // la nueva queda activa
  saveUserStore(userId, s);
  return { label, address };
}

export function createNewWallet(userId) {
  const w = ethers.Wallet.createRandom();
  const { label, address } = addWallet(userId, w.privateKey);
  return { label, address, pk: w.privateKey };
}

export function removeUserWallet(userId, index = null) {
  const s = getUserStore(userId);
  if (!s.list.length) return false;
  if (index == null) index = s.active;
  if (index < 0 || index >= s.list.length) return false;
  s.list.splice(index, 1);
  if (s.active >= s.list.length) s.active = Math.max(0, s.list.length - 1);
  saveUserStore(userId, s);
  return true;
}

// Versión "fácil" para el comando /setwallet antiguo (compat).
export function setUserWallet(userId, pk) {
  return addWallet(userId, pk).address;
}

export function getSignerFor(userId) {
  const w = getActiveWallet(userId);
  if (!w) throw new Error('No tienes wallet configurada. Usa /setwallet o el menú /wallets');
  return new ethers.Wallet(w.pk, getWriteProvider());
}

// Devuelve { signer, label, address } para una wallet específica por índice.
export function getSignerForIndex(userId, index) {
  const s = getUserStore(userId);
  let entry;
  if (s.list.length) {
    if (index < 0 || index >= s.list.length) throw new Error(`Wallet #${index + 1} no existe`);
    const w = s.list[index];
    entry = { label: w.label, address: w.address, pk: decryptPk(w.enc) };
  } else if (isOwner(userId) && index === 0) {
    entry = ownerEnvWallet();
    if (!entry) throw new Error('Sin wallet (.env vacío)');
  } else {
    throw new Error(`Wallet #${index + 1} no existe`);
  }
  return {
    signer: new ethers.Wallet(entry.pk, getWriteProvider()),
    label: entry.label,
    address: entry.address,
  };
}

// Solo para el botón "Export private key" (sensible — el bot mostrará y borra).
export function exportPrivateKey(userId, index = null) {
  const s = getUserStore(userId);
  if (!s.list.length) {
    if (isOwner(userId)) {
      const env = ownerEnvWallet();
      return env ? env.pk : null;
    }
    return null;
  }
  const i = index == null ? s.active : index;
  if (i < 0 || i >= s.list.length) return null;
  return decryptPk(s.list[i].enc);
}
