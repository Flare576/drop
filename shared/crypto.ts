// Ported from ~/Projects/Personal/ei/src/storage/crypto.ts (PBKDF2+AES-GCM dead-drop pattern).
// Pure Web Crypto API (crypto.subtle) — runs unmodified in browsers and Bun/Node >=19.
// New SALT/ID_PLAINTEXT so derived IDs never collide with ei's own flare576.com/ei namespace.
//
// SECURITY MODEL (do not weaken without updating callers):
// - Server never sees username/passphrase/key — only the derived userId (opaque, in URL)
//   and encrypted {iv, ciphertext} blobs. This is the entire reason this architecture is
//   safe to run through a third-party-fronted relay for client (Elevance) code.
// - generateUserId() uses a FIXED all-zero 12-byte IV. This is safe ONLY because it always
//   encrypts the same static ID_PLAINTEXT — never reuse a zero/fixed IV for real payload
//   data. Real encrypt() below always draws a fresh random IV per call.
// - Derived CryptoKey is non-extractable (`extractable: false`) so it can't be exported
//   even if a compromised caller tries.

const PBKDF2_ITERATIONS = 310_000;
const SALT = new TextEncoder().encode("rp-vdi-relay-drop-the-mic");
const ID_PLAINTEXT = "the_relay_is_the_message";
const CHUNK_SIZE = 0x8000; // 32KB chunks — avoids String.fromCharCode stack overflow on large payloads (ei hit this at 18MB+)

export interface CryptoCredentials {
  username: string;
  passphrase: string;
}

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

async function deriveKey(credentials: CryptoCredentials): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${credentials.username}:${credentials.passphrase}`),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Deterministic mailbox ID derived from shared credentials — never transmitted, only its ciphertext output is. */
export async function generateUserId(credentials: CryptoCredentials): Promise<string> {
  const key = await deriveKey(credentials);
  // Fixed IV for deterministic ID — same credentials => same ID. Safe ONLY because the
  // plaintext being encrypted is always this one static string; never do this for real data.
  const iv = new Uint8Array(12); // all zeros, deterministic

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(ID_PLAINTEXT),
  );

  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Encrypts raw bytes. Caller is responsible for any higher-level envelope (e.g. filename headers) — this only ever sees opaque plaintext bytes. */
export async function encrypt(data: Uint8Array, credentials: CryptoCredentials): Promise<EncryptedPayload> {
  const key = await deriveKey(credentials);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as NodeJS.BufferSource);

  return {
    iv: uint8ArrayToBase64(iv),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
  };
}

/** Decrypts back to raw bytes. Caller is responsible for parsing any higher-level envelope out of the result. */
export async function decrypt(payload: EncryptedPayload, credentials: CryptoCredentials): Promise<Uint8Array> {
  const key = await deriveKey(credentials);

  const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(payload.ciphertext), (c) => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);

  return new Uint8Array(decrypted);
}
