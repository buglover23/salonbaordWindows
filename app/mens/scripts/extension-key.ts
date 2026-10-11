import { createHash, generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// The manifest carries a fixed public key so the unpacked extension ID is stable (Plan 3 D1-6). The key pair only
// pins the ID: the private key is never written anywhere (an unpacked extension is never signed with it).

/** Chrome's extension ID: the first 128 bits of SHA-256(DER public key) as hex, digits 0-f mapped to a-p. */
export function idFromKey(b64: string): string {
  const hex = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** A new RSA public key (SPKI DER, base64) and its ID; the private half is discarded. */
export function generateKey(): { key: string; id: string } {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { key, id: idFromKey(key) };
}

// `tsx scripts/extension-key.ts generate` prints the public key (for apps/extension/keys/<target>.pub.b64) and its ID.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'generate') {
    console.error('使い方: tsx scripts/extension-key.ts generate');
    process.exit(2);
  }
  const { key, id } = generateKey();
  console.log(key);
  console.error(`拡張機能のID: ${id}`);
}
