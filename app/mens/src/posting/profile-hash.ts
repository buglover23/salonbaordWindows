import { sha256Hex } from '../shared/hash.js';
import type { PageProfile } from '../shared/protocol/profile.js';

// The owner's verification is bound to the profile content (P3-R37): any edit other than the verification record
// itself changes the hash and voids verified_hash.
const NOT_HASHED = new Set(['verified_at', 'verified_hash', 'owner_attestations']);

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** SHA-256 (hex) of the canonical sorted-key JSON of a parsed profile, without verified_at, verified_hash and owner_attestations. */
export function profileHash(profile: PageProfile): string {
  return sha256Hex(canonicalJson(Object.fromEntries(Object.entries(profile).filter(([k]) => !NOT_HASHED.has(k)))));
}
