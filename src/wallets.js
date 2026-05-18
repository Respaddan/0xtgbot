import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { ethers } from 'ethers';
import { config } from './config.js';
import { isOwner } from './auth.js';
import { getWriteProvider } from './chain.js';

const STORE = new URL('../wallets.json', import.meta.url);

// --- Cifrado AES-256-GCM de las private keys de otros usuarios ---
function deriveKey(salt) {
  if (!config.walletEncKey) {
    throw new Error('Falta WALLET_ENC_KEY en .env para guardar wallets de usuarios');
  }
  return scryptSync(config.walletEncKey, salt, 32);
}

function encryptPk(pk) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(pk, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
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
function loadStore() {
  if (!existsSync(STORE)) return {};
  try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function saveStore(obj) {
  writeFileSync(STORE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function normalizePk(pk) {
  const v = pk.trim();
  const withPrefix = v.startsWith('0x') ? v : `0x${v}`;
  // Lanza si la clave no es válida
  return new ethers.Wallet(withPrefix).privateKey;
}

/** Guarda (cifrada) la wallet propia de un usuario que NO es el dueño. */
export function setUserWallet(userId, pk) {
  const clean = normalizePk(pk);
  const address = new ethers.Wallet(clean).address;
  const store = loadStore();
  store[String(userId)] = encryptPk(clean);
  saveStore(store);
  return address;
}

export function removeUserWallet(userId) {
  const store = loadStore();
  if (store[String(userId)]) {
    delete store[String(userId)];
    saveStore(store);
    return true;
  }
  return false;
}

/** Dirección pública de la wallet de un usuario (o null). */
export function getUserAddress(userId) {
  if (isOwner(userId)) {
    if (!config.privateKey) return null;
    const pk = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
    return new ethers.Wallet(pk).address;
  }
  const store = loadStore();
  const rec = store[String(userId)];
  if (!rec) return null;
  return new ethers.Wallet(decryptPk(rec)).address;
}

/**
 * Devuelve el firmante a usar para ESTE usuario:
 *  - dueño  -> PRIVATE_KEY del .env (solo tuya)
 *  - otros  -> su propia wallet cifrada (la setearon con /setwallet)
 */
export function getSignerFor(userId) {
  if (isOwner(userId)) {
    if (!config.privateKey) throw new Error('El dueño no tiene PRIVATE_KEY en .env');
    const pk = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
    return new ethers.Wallet(pk, getWriteProvider());
  }
  const store = loadStore();
  const rec = store[String(userId)];
  if (!rec) {
    throw new Error('No tienes wallet configurada. Usa /setwallet <private_key> en un chat privado.');
  }
  return new ethers.Wallet(decryptPk(rec), getWriteProvider());
}
