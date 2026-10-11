import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { systemClock } from '../shared/clock.js';
import { AppFailure, appError } from '../shared/errors.js';
import { jstCompact } from '../shared/time.js';
import { FORBIDDEN_SKELETON_ATTR, maskPath, maskSensitiveText, SurveyCaptureSchema, type SurveyCapture } from '../shared/protocol/survey.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import { resolveDataPaths } from '../storage/paths.js';

// Survey captures on disk (D9): <dataRoot>/data/survey/<YYYYMMDD-HHmmss>-<kind>-<slug>.json, gitignored, shared by both
// modes. Node's masking is authoritative: every string is masked again before a file is written, and again when read.
// An agent may read a capture only after the owner wrote <name>.approved with survey:show --approve.

const PATH_KEYS = new Set(['path', 'action_path']);
/** What a file name may look like (no folders, no '..'). */
export const SURVEY_FILE = /^\d{8}-\d{6}-[a-z0-9_-]{1,120}\.json$/i;

function remask(v: unknown, key: string): unknown {
  if (typeof v === 'string') return PATH_KEYS.has(key) ? maskPath(v) : maskSensitiveText(v);
  if (Array.isArray(v)) return v.map((x) => remask(x, key));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remask(x, k)]));
  return v;
}

/** Masks every string again and re-validates; a skeleton that still carries a dropped attribute is refused. */
export function sanitizeCapture(raw: unknown): { ok: true; capture: SurveyCapture } | { ok: false; reason_ja: string } {
  const parsed = SurveyCaptureSchema.safeParse(remask(raw, ''));
  if (!parsed.success) return { ok: false, reason_ja: '調査結果の形式が正しくありません（長すぎる文字列や不明な項目があります）' };
  if (FORBIDDEN_SKELETON_ATTR.test(parsed.data.skeleton_html)) {
    return { ok: false, reason_ja: '調査結果に保存できない属性（aria-label・title・alt・placeholder・on…・src・data-…）が残っています' };
  }
  return { ok: true, capture: parsed.data };
}

const ascii = (s: string, max: number): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');

/** The file name for a capture: JST time, kind and an ASCII slug of the masked path; a linked outline names its job. */
export function surveyFileName(c: SurveyCapture, now: Date, link: { job_id: string; attempt_id: string } | null): string {
  const tail = link === null ? `${c.kind}-${ascii(c.page.path, 40) || 'page'}` : `outline-${ascii(link.job_id, 50)}-${ascii(link.attempt_id, 50)}`;
  return `${jstCompact(now)}-${tail}.json`;
}

/** Writes a sanitized capture under a new name (never over an existing file) and returns the name. */
export async function saveCapture(dir: string, c: SurveyCapture, now: Date, link: { job_id: string; attempt_id: string } | null): Promise<string> {
  await mkdir(dir, { recursive: true });
  const base = surveyFileName(c, now, link).replace(/\.json$/, '');
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.json` : `${base}-${n}.json`;
    try {
      await writeFile(join(dir, name), `${JSON.stringify(c, null, 2)}\n`, { flag: 'wx' });
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 99) throw err;
    }
  }
}

export type StoredSurvey = { name: string; approved: boolean } & ({ ok: true; capture: SurveyCapture } | { ok: false; reason_ja: string });

/** Reads one capture by file name (re-masked and re-validated, as an agent would see it). */
export async function readCapture(dir: string, name: string): Promise<StoredSurvey | null> {
  if (!SURVEY_FILE.test(name)) return null;
  let text: string;
  try {
    text = await readFile(join(dir, name), 'utf8');
  } catch {
    return null;
  }
  const approved = await readFile(join(dir, `${name}.approved`)).then(
    () => true,
    () => false,
  );
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { name, approved, ok: false, reason_ja: 'JSON として読み取れません' };
  }
  return { name, approved, ...sanitizeCapture(json) };
}

/** Every capture, oldest first. */
export async function listCaptures(dir: string): Promise<StoredSurvey[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: StoredSurvey[] = [];
  for (const name of names.filter((n) => SURVEY_FILE.test(n)).sort()) {
    const s = await readCapture(dir, name);
    if (s !== null) out.push(s);
  }
  return out;
}

/** <dataRoot>/data/survey of a project (its settings.json decides the data root). */
export async function surveyDirOf(projectRoot: string): Promise<string> {
  const r = await loadConfig(join(projectRoot, 'config'));
  if (!r.ok) throw new AppFailure(appError('CONFIG_INVALID', 'cli', systemClock, { details: { issues: r.issues } }));
  return resolveDataPaths(projectRoot, r.snapshot.settings).surveyDir;
}

/** The owner's approval marker (<name>.approved): only approved captures may be read by an agent. */
export const approveCapture = (dir: string, name: string, now: Date): Promise<void> => writeJsonAtomic(join(dir, `${name}.approved`), { approved_at: now.toISOString() });
