import { readFile } from 'node:fs/promises';
import { errnoCode, storageFailure } from '../storage/atomic-json.js';

// The project's .env file, read the way Node's process.loadEnvFile reads single-line entries (KEY=VALUE, `export `
// prefix, '…' "…" `…` quotes, # comments outside quotes, a variable already in the environment wins), plus line numbers
// for messages, a leading BOM (Notepad) and line problems instead of silently skipped or swallowed lines. Multi-line
// quoted values are not supported: an unclosed quote is a problem on its own line. The one .env reader of the tool
// (runtime, CLI commands, ai:test via ai-setup.ts); the file is never copied into process.env and values are never logged.

/** One KEY=VALUE line (line numbers are 1-based). */
export interface EnvEntry {
  key: string;
  value: string;
  line: number;
}

/** A line that is neither blank, a comment nor KEY=VALUE; `key` is what stands before "=" (or the whole line without one). */
export interface EnvLineProblem {
  line: number;
  key: string | null;
  reason: 'no_equals' | 'unterminated_quote' | 'empty_key';
}

export interface EnvFile {
  path: string;
  /** false: there is no .env file, which is not an error. */
  exists: boolean;
  /** In file order; a key written twice appears twice and the later line applies. */
  entries: EnvEntry[];
  problems: EnvLineProblem[];
}

/** A variable's value and where it came from: the .env line, or null when it was set in the environment. */
export interface EnvValue {
  value: string;
  line: number | null;
}

export interface EnvSource {
  /** The value the process uses: the environment's (unless blank), else the file's last line for the key. */
  get(key: string): EnvValue | undefined;
  /** What the file says for the key (its last line), whatever the environment says. */
  fileValue(key: string): EnvValue | undefined;
  /** Every key set in the environment or the file. */
  keys(): string[];
  file: EnvFile | null;
}

const QUOTES = new Set(['"', "'", '`']);
const EXPORT_PREFIX = /^export\s+/;

export function parseEnvText(text: string): { entries: EnvEntry[]; problems: EnvLineProblem[] } {
  const entries: EnvEntry[] = [];
  const problems: EnvLineProblem[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const eq = raw.indexOf('=');
    if (eq < 0) {
      problems.push({ line, key: trimmed.replace(EXPORT_PREFIX, '').split(/\s+/)[0] ?? null, reason: 'no_equals' });
      return;
    }
    const key = raw.slice(0, eq).trim().replace(EXPORT_PREFIX, '').trim();
    if (key === '') {
      problems.push({ line, key: null, reason: 'empty_key' });
      return;
    }
    const rest = raw.slice(eq + 1).trim();
    const quote = rest.charAt(0);
    if (QUOTES.has(quote)) {
      const end = rest.indexOf(quote, 1);
      if (end < 0) {
        problems.push({ line, key, reason: 'unterminated_quote' });
        return;
      }
      const inner = rest.slice(1, end);
      entries.push({ key, value: quote === '"' ? inner.replaceAll('\\n', '\n') : inner, line });
      return;
    }
    const hash = rest.indexOf('#');
    entries.push({ key, value: (hash < 0 ? rest : rest.slice(0, hash)).trim(), line });
  });
  return { entries, problems };
}

/** Reads `path`; a missing file is `exists: false`. Bytes that are not UTF-8 (e.g. a comment saved as Shift_JIS) are replaced, not refused. */
export async function readEnvFile(path: string): Promise<EnvFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { path, exists: false, entries: [], problems: [] };
    throw storageFailure(err, '.env ファイルの読み込み', path);
  }
  return { path, exists: true, ...parseEnvText(new TextDecoder('utf-8').decode(bytes)) };
}

function lastByKey(file: EnvFile | null): Map<string, EnvEntry> {
  const map = new Map<string, EnvEntry>();
  for (const e of file?.entries ?? []) map.set(e.key, e);
  return map;
}

/**
 * The variables as the process sees them once the file is applied. A value the environment holds that equals the
 * file's (the file was already applied) is reported with its line.
 */
export function envSource(file: EnvFile | null, env: Readonly<Record<string, string | undefined>> = process.env): EnvSource {
  const fromFile = lastByKey(file);
  const fileValue = (key: string): EnvValue | undefined => {
    const e = fromFile.get(key);
    return e === undefined ? undefined : { value: e.value, line: e.line };
  };
  return {
    get(key) {
      const own = Object.hasOwn(env, key) ? env[key] : undefined;
      // A blank environment variable (e.g. set empty in Windows) does not hide the file's value.
      if (own === undefined || own.trim() === '') return fileValue(key) ?? (own === undefined ? undefined : { value: own, line: null });
      const f = fromFile.get(key);
      return { value: own, line: f !== undefined && f.value === own ? f.line : null };
    },
    fileValue,
    keys: () => [...new Set([...Object.keys(env).filter((k) => env[k] !== undefined), ...fromFile.keys()])],
    file,
  };
}
