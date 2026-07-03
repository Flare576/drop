import type { CryptoCredentials, EncryptedPayload } from "../shared/crypto.ts";

export type { CryptoCredentials, EncryptedPayload } from "../shared/crypto.ts";

export function generateUserId(credentials: CryptoCredentials): Promise<string>;
export function encrypt(data: string, credentials: CryptoCredentials): Promise<EncryptedPayload>;
export function decrypt(payload: EncryptedPayload, credentials: CryptoCredentials): Promise<string>;
