import { CHUNK_BYTES, type PostCommand, type SwMessage } from '../../../../src/shared/protocol/index.js';
import type { ApiClient } from './api-client.js';

// The upload image of the current command only: fetched once (signature and SHA-256 checked), handed to the content
// script in 768 KiB chunks, dropped at command end. A miss after an SW restart fetches it again.

const cache = new Map<string, Uint8Array>();

export async function assetChunk(api: ApiClient, cmd: PostCommand, index: number): Promise<Extract<SwMessage, { type: 'chunk' }> | null> {
  let bytes = cache.get(cmd.command_id);
  if (bytes === undefined) {
    const q = (s: string): string => encodeURIComponent(s);
    const got = await api.asset(`/v1/jobs/${q(cmd.job_id)}/asset?attempt_id=${q(cmd.attempt_id)}&command_id=${q(cmd.command_id)}`, cmd.image);
    if (got === null) return null;
    cache.clear();
    cache.set(cmd.command_id, got);
    bytes = got;
  }
  return chunkOf(bytes, index, cmd.image.sha256);
}

/** Chunk `index` of `bytes` as a `chunk` message (768 KiB raw, base64), or null past the end. */
export function chunkOf(bytes: Uint8Array, index: number, sha256: string): Extract<SwMessage, { type: 'chunk' }> | null {
  const total = Math.ceil(bytes.length / CHUNK_BYTES);
  if (index >= total) return null;
  let bin = '';
  for (const b of bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)) bin += String.fromCharCode(b);
  return { type: 'chunk', index, total, sha256, b64: btoa(bin) };
}

export const dropAsset = (): void => cache.clear();
