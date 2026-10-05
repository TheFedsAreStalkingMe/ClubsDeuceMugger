// Hashing, random tokens and encoding helpers (Web Crypto).

import { PBKDF2_ITERATIONS } from "../config.js";

const enc = new TextEncoder();

export function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 32 random bytes as URL-safe text. Only the SHA-256 of a token is ever stored.
export function randomToken() {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// New password -> values to store in the users table.
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return { password_hash: b64(hash), salt: b64(salt), iterations: PBKDF2_ITERATIONS };
}

// Compare a typed password with a users row.
export async function checkPassword(password, row) {
  const hash = await pbkdf2(password, unb64(row.salt), row.iterations);
  return timingSafeEqual(hash, unb64(row.password_hash));
}

// Spend the same time as a real check, so usernames cannot be probed by timing.
export const burnPasswordTime = (password) => pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);

// ---- saved API keys: locked with the member's own password (AES-GCM) ----
//
// vault key  = PBKDF2(password, key_salt)       made at sign-in or when saving; never stored
// users.key_enc    = keys sealed with the vault key
// sessions.vault_key = the vault key wrapped with a key made from this session's cookie, so the server
//                      can read the keys while the member is signed in, and a database copy alone cannot.

const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));
export { newSalt };

async function aesKey(bytes) {
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptBytes(keyBytes, aad, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(keyBytes), plain);
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

async function decryptBytes(keyBytes, aad, sealed) {
  const [iv, ct] = sealed.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(aad) }, await aesKey(keyBytes), unb64(ct));
  return new Uint8Array(plain);
}

export const vaultKeyFrom = (password, saltB64) => pbkdf2(password, unb64(saltB64), PBKDF2_ITERATIONS);

export const sealKeys = (vaultKey, userId, keys) => encryptBytes(vaultKey, `keys:${userId}`, enc.encode(JSON.stringify(keys)));

export async function openKeys(vaultKey, userId, sealed) {
  return JSON.parse(new TextDecoder().decode(await decryptBytes(vaultKey, `keys:${userId}`, sealed)));
}

const sessionWrapKey = async (token) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`vault:${token}`)));

export async function wrapForSession(token, vaultKey, userId) {
  return encryptBytes(await sessionWrapKey(token), `vault:${userId}`, vaultKey);
}

export async function unwrapFromSession(token, wrapped, userId) {
  return decryptBytes(await sessionWrapKey(token), `vault:${userId}`, wrapped);
}
