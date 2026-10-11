import {
  canonicalPairClient,
  canonicalPairServer,
  fingerprint,
  normalizePairingCode,
  PairBeginResponseSchema,
  PairFinishResponseSchema,
} from '../../../../src/shared/protocol/index.js';
import type { ApiClient } from './api-client.js';
import { b64url, fromB64url, hex, hkdf, hmac, hmacKey, sameBytes, sha256, utf8 } from './crypto.js';
import { saveClientKey } from './key-store.js';

// Pairing (D1-4): both sides prove they know the code; the code and the key never cross the wire.
//   client_proof = HMAC(code, pair-c|…), server_proof = HMAC(code, pair-s|…|hex(sha256(sealed_key bytes)))
//   K_c = sealed_key XOR HKDF-SHA256(ikm = code, salt = client_nonce|server_nonce, info = "seal", 32)
// The HMAC/HKDF key is the normalized code (10 Crockford characters, no '-') as UTF-8.

export type PairOutcome = { ok: true; fingerprint: string } | { ok: false; message: string };

const fail = (message: string): PairOutcome => ({ ok: false, message });

export async function pair(api: ApiClient, codeInput: string, extensionId: string): Promise<PairOutcome> {
  const code = normalizePairingCode(codeInput);
  if (code === null) return fail('接続コードは XXXXX-XXXXX の形（英数字10文字）で入力してください');
  const codeKey = await hmacKey(utf8(code));
  const clientNonce = b64url(crypto.getRandomValues(new Uint8Array(32)));

  const begin = await api.unsigned('/v1/extension/pair/begin', { client_nonce: clientNonce, extension_id: extensionId }, PairBeginResponseSchema);
  if (begin.kind !== 'ok') return fail(refusal(begin));
  const { pairing_id: pairingId, server_nonce: serverNonce } = begin.body;

  const clientProof = b64url(await hmac(codeKey, canonicalPairClient({ pairingId, clientNonce, serverNonce, extensionId })));
  const finish = await api.unsigned('/v1/extension/pair/finish', { pairing_id: pairingId, client_proof: clientProof }, PairFinishResponseSchema);
  if (finish.kind !== 'ok') return fail(refusal(finish));
  const { client_id: clientId, sealed_key: sealedB64, server_proof: serverProof } = finish.body;

  const sealed = fromB64url(sealedB64);
  const expected = await hmac(codeKey, canonicalPairServer({ pairingId, clientNonce, serverNonce, clientId, sealedKeySha256Hex: hex(await sha256(sealed)) }));
  if (sealed.length !== 32 || !sameBytes(expected, fromB64url(serverProof))) {
    return fail('ツールからの応答を確認できませんでした。別のプログラムが応答した可能性があります。ツールを起動し直してから、もう一度接続してください');
  }
  const mask = await hkdf(utf8(code), utf8(`${clientNonce}|${serverNonce}`), 'seal', 32);
  const raw = sealed.map((b, i) => b ^ (mask[i] ?? 0));
  const fp = await fingerprint(clientId, sha256);
  await saveClientKey({ client_id: clientId, key: await hmacKey(raw), fingerprint: fp });
  raw.fill(0);
  return { ok: true, fingerprint: fp };
}

function refusal(r: { kind: 'refused'; error: { code: string } } | { kind: 'unknown' }): string {
  if (r.kind === 'unknown') return 'ツールに接続できません。ツールが起動しているか確認してください';
  switch (r.error.code) {
    case 'PAIRING_FAILED':
      return '接続コードが違うか、期限（5分）が切れています';
    case 'PAIRING_LOCKED':
      return '接続コードを5回間違えたため受付を止めました。「接続」を押してもう一度始めてください';
    case 'PAIRING_NOT_OPEN':
      return '接続の受付が開いていません。「接続」を押すか、別の PowerShell で npm.cmd run pair を実行してください';
    case 'FORBIDDEN':
      return 'この拡張機能はツールの設定で許可されていません（拡張機能のIDを確認してください）';
    default:
      return `接続できませんでした（${r.error.code}）`;
  }
}
