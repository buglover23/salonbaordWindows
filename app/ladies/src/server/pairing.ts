import { hkdfSync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { CROCKFORD_ALPHABET, canonicalPairClient, canonicalPairServer, fingerprint } from '../shared/protocol/signing.js';
import { b64url, hmac, safeEqual, sha256 } from './auth.js';
import { clientKey } from './keys.js';

// Mutual-proof pairing (Plan 3 D1-4). The code never crosses the wire: the extension proves it with client_proof, Node
// proves it with server_proof, and K_c travels once, sealed with a pad derived from the code. Byte conventions shared
// with the service worker: every string is UTF-8; the code is the 10 normalized characters without '-'; HKDF-SHA256
// with ikm = code, salt = client_nonce + "|" + server_nonce, info = "seal", 32 bytes; sealed_key = K_c XOR pad;
// server_proof covers hex(sha256(raw sealed bytes)); binary values are base64url without padding.

export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_TRIES = 5;
const POPUP_GAP_MS = 10_000;
const POPUP_PER_HOUR = 10;
const HOUR_MS = 3_600_000;

interface PairingWindow {
  code: string;
  expiresAt: number;
  tries: number;
  locked: boolean;
  /** The latest begin; a newer begin replaces it. */
  begun: { pairingId: string; clientNonce: string; extensionId: string } | null;
}

export interface PairingSuccess {
  client_id: string;
  sealed_key: string;
  server_proof: string;
  fingerprint: string;
  extension_id: string;
}

export class PairingService {
  readonly #master: Uint8Array;
  readonly #serverNonce: string;
  #window: PairingWindow | null = null;
  #popupOpens: number[] = [];

  constructor(d: { master: Uint8Array; serverNonce: string }) {
    this.#master = d.master;
    this.#serverNonce = d.serverNonce;
  }

  /** Opens a new window (replacing any open one). The code is shown as XXXXX-XXXXX. The popup is rate limited. */
  open(now: Date, by: 'start' | 'popup' | 'cli'): { code: string; expiresAt: Date } | 'rate_limited' {
    const t = now.getTime();
    if (by === 'popup') {
      const recent = this.#popupOpens.filter((at) => t - at < HOUR_MS);
      if (recent.length >= POPUP_PER_HOUR || t - (recent.at(-1) ?? -Infinity) < POPUP_GAP_MS) return 'rate_limited';
      this.#popupOpens = [...recent, t];
    }
    const code = Array.from({ length: 10 }, () => CROCKFORD_ALPHABET[randomInt(32)]).join('');
    this.#window = { code, expiresAt: t + PAIRING_TTL_MS, tries: 0, locked: false, begun: null };
    return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt: new Date(t + PAIRING_TTL_MS) };
  }

  begin(req: { client_nonce: string; extension_id: string }, now: Date): { pairing_id: string; server_nonce: string } | 'not_open' | 'locked' {
    const w = this.#window;
    if (w === null || now.getTime() >= w.expiresAt) return 'not_open';
    if (w.locked) return 'locked';
    const pairingId = randomUUID();
    w.begun = { pairingId, clientNonce: req.client_nonce, extensionId: req.extension_id };
    return { pairing_id: pairingId, server_nonce: this.#serverNonce };
  }

  /** A wrong proof (or an unknown pairing_id) uses up one of 5 tries; the 5th locks the window. */
  async finish(req: { pairing_id: string; client_proof: string }, now: Date): Promise<PairingSuccess | 'wrong' | 'locked' | 'expired'> {
    const w = this.#window;
    if (w === null || now.getTime() >= w.expiresAt) return 'expired';
    if (w.locked) return 'locked';
    const b = w.begun;
    const serverNonce = this.#serverNonce;
    const expected = b === null ? '' : b64url(hmac(w.code, canonicalPairClient({ pairingId: b.pairingId, clientNonce: b.clientNonce, serverNonce, extensionId: b.extensionId })));
    if (b === null || b.pairingId !== req.pairing_id || !safeEqual(expected, req.client_proof)) {
      w.tries += 1;
      if (w.tries < MAX_TRIES) return 'wrong';
      w.locked = true;
      return 'locked';
    }
    this.#window = null;
    const clientId = randomBytes(16).toString('base64url');
    const key = clientKey(this.#master, clientId);
    const pad = new Uint8Array(hkdfSync('sha256', w.code, `${b.clientNonce}|${serverNonce}`, 'seal', 32));
    const sealed = key.map((byte, i) => byte ^ pad[i]!);
    const proof = hmac(w.code, canonicalPairServer({ pairingId: b.pairingId, clientNonce: b.clientNonce, serverNonce, clientId, sealedKeySha256Hex: sha256(sealed).toString('hex') }));
    return {
      client_id: clientId,
      sealed_key: b64url(sealed),
      server_proof: b64url(proof),
      fingerprint: await fingerprint(clientId, async (s) => sha256(s)),
      extension_id: b.extensionId,
    };
  }
}
