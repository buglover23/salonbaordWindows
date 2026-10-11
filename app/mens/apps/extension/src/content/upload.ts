import { SwMessageSchema, type PostCommand } from '../../../../src/shared/protocol/index.js';
import { anyOf } from '../salonboard/engine/signals.js';
import { waitFor } from '../salonboard/engine/wait.js';
import { hex, sha256 } from '../sw/crypto.js';
import { Stop, type CsEnv, type Post } from './common.js';
import { state } from './guard.js';

// The image (D6): pulled from the SW in 768 KiB chunks, checked against the announced size and SHA-256, set on the file
// input through the page's own path (DataTransfer), then the profile's preview signal. Never an internal API.

/** The command's image, or null when a chunk is missing or the bytes are not exactly the announced ones. */
export async function pullImage(env: CsEnv, cmd: PostCommand): Promise<File | null> {
  const { bytes, sha256: want, chunk_bytes } = cmd.image;
  const total = Math.ceil(bytes / chunk_bytes);
  const out = new Uint8Array(bytes);
  let at = 0;
  for (let index = 0; index < total; index++) {
    const m = SwMessageSchema.safeParse(await env.send({ type: 'cs.chunk_request', command_id: cmd.command_id, index }));
    if (!m.success || m.data.type !== 'chunk' || m.data.index !== index || m.data.total !== total || m.data.sha256 !== want) return null;
    let bin: string;
    try {
      bin = atob(m.data.b64);
    } catch {
      return null;
    }
    if (at + bin.length > bytes) return null;
    for (let i = 0; i < bin.length; i++) out[at++] = bin.charCodeAt(i);
  }
  if (at !== bytes || hex(await sha256(out)) !== want) return null;
  return new File([out], cmd.image.file_name, { type: cmd.image.mime });
}

/** Steps 8: UPLOAD_UNSUPPORTED (the input does not keep exactly the file), UPLOAD_FAILED (error signal), UPLOAD_TIMEOUT. */
export async function upload(post: Post, input: Element): Promise<void> {
  const { env, cmd } = post;
  const p = cmd.profile;
  const shown = p.image.modal?.thumbnail ?? p.image.preview;
  const file = await pullImage(env, cmd);
  post.check();
  if (file === null) throw new Stop('UPLOAD_FAILED', 'asset_unavailable');
  post.phase = 'uploading';
  await post.mutate();
  const set = env.setFile(input, file);
  post.check();
  if (!set.ok) throw new Stop('UPLOAD_UNSUPPORTED', `upload:${set.detail}`);
  const seen = await waitFor(
    () => (state.leaving ? 'left' : anyOf(env.doc, p.failure_signals.upload_error) ? 'error' : anyOf(env.doc, shown) ? 'preview' : null),
    { timeoutMs: p.image.preview_timeout_ms, root: env.doc },
  );
  post.check();
  if (seen === 'error') throw new Stop('UPLOAD_FAILED', 'upload_error_signal');
  if (seen === null) throw new Stop('UPLOAD_TIMEOUT', 'preview_timeout');
}
