// Canonical strings for the HMAC signatures (Plan 3 D1). Pure: the HMAC and SHA-256 themselves are injected
// (node:crypto in Node, WebCrypto in the service worker), so both sides sign exactly the same text.

export type Hmac = (key: Uint8Array, data: string) => Promise<Uint8Array>;

function join(parts: string[], free: number): string {
  // Only the one free-form part (the path) may contain '|'; the parts around it are fixed tokens.
  parts.forEach((p, i) => {
    if (i !== free && p.includes('|')) throw new Error('署名の要素に | は使えません');
  });
  return parts.join('|');
}

export function canonicalRequest(p: { serverNonce: string; requestId: string; method: string; pathAndQuery: string; bodySha256Hex: string }): string {
  return join(['req', p.serverNonce, p.requestId, p.method, p.pathAndQuery, p.bodySha256Hex], 4);
}

export function canonicalResponse(p: { requestId: string; status: number; bodySha256Hex: string }): string {
  return join(['res', p.requestId, String(p.status), p.bodySha256Hex], -1);
}

/** client_proof = HMAC(code, this). */
export function canonicalPairClient(p: { pairingId: string; clientNonce: string; serverNonce: string; extensionId: string }): string {
  return join(['pair-c', p.pairingId, p.clientNonce, p.serverNonce, p.extensionId], -1);
}

/** server_proof = HMAC(code, this). */
export function canonicalPairServer(p: { pairingId: string; clientNonce: string; serverNonce: string; clientId: string; sealedKeySha256Hex: string }): string {
  return join(['pair-s', p.pairingId, p.clientNonce, p.serverNonce, p.clientId, p.sealedKeySha256Hex], -1);
}

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 4 Crockford base32 characters from the first 20 bits of SHA-256(client_id): 「確認記号」 shown on both sides. */
export async function fingerprint(clientId: string, sha256: (s: string) => Promise<Uint8Array>): Promise<string> {
  const d = await sha256(clientId);
  const bits = ((d[0] ?? 0) << 12) | ((d[1] ?? 0) << 4) | ((d[2] ?? 0) >> 4);
  return [15, 10, 5, 0].map((shift) => CROCKFORD_ALPHABET[(bits >> shift) & 31]).join('');
}

/**
 * The pairing code as both sides use it for the HMAC key: 10 upper-case Crockford characters, no separator.
 * Typed input may be lower case with a '-' or spaces; I/L read as 1 and O as 0. Anything else → null.
 */
export function normalizePairingCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return s.length === 10 && [...s].every((c) => CROCKFORD_ALPHABET.includes(c)) ? s : null;
}
