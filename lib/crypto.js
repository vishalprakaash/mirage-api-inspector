/**
 * AES-256-GCM encryption for Mirage storage.
 * Key is derived deterministically from the extension ID + a stored salt.
 * This means data survives browser restarts without storing the key itself.
 */

const PBKDF2_ITERATIONS = 150000;
const KEY_USAGE = ['encrypt', 'decrypt'];

let _cachedKey = null;

async function getSalt() {
  return new Promise((resolve) => {
    chrome.storage.local.get('__mirage_salt__', (result) => {
      if (result.__mirage_salt__) {
        resolve(base64ToBuffer(result.__mirage_salt__));
      } else {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        chrome.storage.local.set({ __mirage_salt__: bufferToBase64(salt) }, () => {
          resolve(salt);
        });
      }
    });
  });
}

async function deriveKey() {
  if (_cachedKey) return _cachedKey;

  const salt = await getSalt();
  const extId = chrome.runtime.id;

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(extId),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  _cachedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    KEY_USAGE
  );

  return _cachedKey;
}

async function encrypt(plaintext) {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(plaintext));

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  return {
    iv: bufferToBase64(iv),
    data: bufferToBase64(new Uint8Array(ciphertext))
  };
}

async function decrypt(encrypted) {
  const key = await deriveKey();
  const iv = base64ToBuffer(encrypted.iv);
  const ciphertext = base64ToBuffer(encrypted.data);

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

  return JSON.parse(new TextDecoder().decode(plaintext));
}

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export { encrypt, decrypt };
