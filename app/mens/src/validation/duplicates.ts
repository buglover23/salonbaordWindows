import { PENDING_DRAFT_STATUSES, type DraftJobReader } from '../ai/context.js';
import { DraftSchema, primaryFieldOf, primaryTextOf, type Draft } from '../ai/draft-schemas.js';
import { graphemeSlice } from '../shared/text.js';
import type { PostType } from '../shared/types.js';
import { comparisonChars, compareTexts, textHash, type SimilarityResult } from './similarity.js';
import { fieldJa, violation, type Violation } from './types.js';

// Spec 10.3 duplicate checks: exact (hash of the comparison text) against every posted text of the salon, near-duplicate
// against the recent posts and the drafts waiting to be posted, and copies of the Excel examples (spec 7, A13 / A14).
// Same keywords alone or the same hashtag set alone never make a duplicate: only titles and texts are compared.

export interface DuplicateText {
  origin: 'history' | 'draft';
  job_id: string;
  post_type: PostType;
  title: string;
  /** The primary text (stylist comment / body) without the hashtags. */
  primary_text: string;
}

/** Hashes of one posted job's title and primary text (textHash; null when it had none). */
export interface PostedHash {
  job_id: string;
  post_type: PostType;
  title_hash: string | null;
  body_hash: string | null;
}

/** An Excel example the generation context offered (its id is the evidence id excel:<sheet>!<row>). */
export interface ExcelReference {
  id: string;
  title: string;
  comment: string | null;
}

export interface DuplicateCandidates {
  /** Full texts: the last settings.duplicates.recent_posts posted entries and the drafts of other jobs waiting to post. */
  texts: readonly DuplicateText[];
  /** Every posted title / text hash of the salon (history entries, older hashes, dedupe records). */
  hashes: readonly PostedHash[];
  /** Excel examples whose title and comment must not be copied. */
  excel: readonly ExcelReference[];
}

export interface DuplicateOptions {
  /** settings.duplicates.title_similarity_threshold: character-bigram Jaccard at or above it is a near-duplicate. */
  titleThreshold: number;
  /** settings.duplicates.body_similarity_threshold: character-trigram Jaccard at or above it is a near-duplicate. */
  bodyThreshold: number;
  /** The job being checked: never compared with itself (a safe retry of the same job, spec 10.3). */
  excludeJobId?: string;
}

export const DEFAULT_DUPLICATE_OPTIONS: DuplicateOptions = { titleThreshold: 0.85, bodyThreshold: 0.9 };
/** A title at least this similar (bigram Jaccard) to an Excel example title is a copy (spec A13). */
export const EXCEL_TITLE_THRESHOLD = 0.85;
/** This many consecutive graphemes (comparison form) of an Excel comment in the post are a copy (spec A13). */
export const EXCEL_COPY_RUN = 20;
/** A previous primary text at least this long (comparison form) found whole inside the draft, or the other way round, is a copy (spec 9.7). */
export const MIN_CONTAINED_TEXT = 20;

const round = (n: number): number => Math.round(n * 1000) / 1000;

const originJa = (o: DuplicateText['origin']): string => (o === 'history' ? '投稿済み' : '投稿待ち');

function similarityNote(r: SimilarityResult, threshold: number): string {
  return r.method === 'edit_distance' ? `短い文のため編集距離で比較: ${r.edits}文字違い、2文字以内で類似` : `類似度 ${round(r.similarity)}、基準 ${threshold} 以上で類似`;
}

function runs(chars: readonly string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(''));
  return out;
}

interface Best {
  candidate: DuplicateText;
  result: SimilarityResult;
}

/** The most similar near-duplicate among `texts`, or null. */
function bestNear(texts: readonly DuplicateText[], pick: (t: DuplicateText) => string, own: string, kind: 'title' | 'body', threshold: number): Best | null {
  let best: Best | null = null;
  for (const candidate of texts) {
    const other = pick(candidate);
    if (other.trim() === '') continue;
    const result = compareTexts(own, other, kind, threshold);
    if (result.near && (best === null || result.similarity > best.result.similarity)) best = { candidate, result };
  }
  return best;
}

/**
 * Duplicate findings for `draft` (all hard): duplicate_title / duplicate_body (exact, any posted job of the salon),
 * near_duplicate_title / near_duplicate_body (recent posts and waiting drafts, spec 10.3 thresholds; short texts by edit
 * distance), copied_previous_text (a whole earlier text inside this one or the other way round, spec 9.7), and
 * excel_title_copy / excel_comment_copy (spec A13). The job itself is never a candidate.
 */
export function checkDuplicates(draft: Draft, candidates: DuplicateCandidates, options: Partial<DuplicateOptions> = {}): Violation[] {
  const o = { ...DEFAULT_DUPLICATE_OPTIONS, ...options };
  const out: Violation[] = [];
  const primaryField = primaryFieldOf(draft.post_type);
  const primary = primaryTextOf(draft);
  const others = candidates.texts.filter((t) => t.job_id !== o.excludeJobId);
  const hashes = candidates.hashes.filter((h) => h.job_id !== o.excludeJobId);

  // Exact: the hash of the comparison text, against every posted job.
  const titleChars = comparisonChars(draft.title);
  const primaryChars = comparisonChars(primary);
  let titleDone = false;
  let bodyDone = false;
  if (titleChars.length > 0) {
    const h = textHash(draft.title);
    const hit = hashes.find((x) => x.title_hash === h);
    if (hit !== undefined) {
      titleDone = true;
      out.push(
        violation('title', 'duplicate_title', 'hard', `タイトルが投稿済みの投稿（${hit.job_id}）のタイトルと同じです（記号・空白・全角半角の違いを除いて一致）。別のタイトルにしてください。`, {
          offending_text: draft.title,
        }),
      );
    }
  }
  if (primaryChars.length > 0) {
    const h = textHash(primary);
    const hit = hashes.find((x) => x.body_hash === h);
    if (hit !== undefined) {
      bodyDone = true;
      out.push(
        violation(primaryField, 'duplicate_body', 'hard', `${fieldJa(primaryField)}が投稿済みの投稿（${hit.job_id}）の文章と同じです（記号・空白・全角半角の違いを除いて一致）。書き直してください。`, {
          offending_text: graphemeSlice(primary, 80),
        }),
      );
    }
  }

  // Near: recent posts and waiting drafts.
  if (!titleDone && titleChars.length > 0) {
    const best = bestNear(others, (t) => t.title, draft.title, 'title', o.titleThreshold);
    if (best !== null) {
      out.push(
        violation(
          'title',
          'near_duplicate_title',
          'hard',
          `タイトルが${originJa(best.candidate.origin)}の投稿（${best.candidate.job_id}）のタイトル「${best.candidate.title}」とよく似ています（${similarityNote(best.result, o.titleThreshold)}）。別の切り口のタイトルにしてください。`,
          { actual: round(best.result.similarity), limit: best.result.method === 'edit_distance' ? 'edit_distance<=2' : o.titleThreshold, offending_text: draft.title },
        ),
      );
    }
  }
  if (!bodyDone && primaryChars.length > 0) {
    const best = bestNear(others, (t) => t.primary_text, primary, 'body', o.bodyThreshold);
    if (best !== null) {
      bodyDone = true;
      out.push(
        violation(
          primaryField,
          'near_duplicate_body',
          'hard',
          `${fieldJa(primaryField)}が${originJa(best.candidate.origin)}の投稿（${best.candidate.job_id}）の文章とよく似ています（${similarityNote(best.result, o.bodyThreshold)}）。書き出し・構成・説明を変えて書き直してください。`,
          { actual: round(best.result.similarity), limit: best.result.method === 'edit_distance' ? 'edit_distance<=2' : o.bodyThreshold, offending_text: graphemeSlice(primary, 80) },
        ),
      );
    }
  }
  if (!bodyDone && primaryChars.length > 0) {
    const own = primaryChars.join('');
    const copied = others.find((t) => {
      const theirs = comparisonChars(t.primary_text).join('');
      const shorter = Math.min([...own].length, [...theirs].length);
      return shorter >= MIN_CONTAINED_TEXT && (own.includes(theirs) || theirs.includes(own));
    });
    if (copied !== undefined) {
      out.push(
        violation(
          primaryField,
          'copied_previous_text',
          'hard',
          `${fieldJa(primaryField)}に、${originJa(copied.origin)}の投稿（${copied.job_id}）の文章がそのまま含まれています（スタイルコメントをブログへ転記するなど）。自分の言葉で書き直してください。`,
          { offending_text: graphemeSlice(copied.primary_text, 80) },
        ),
      );
    }
  }

  // Excel examples: never their title, never 20 consecutive characters of their comment.
  for (const ref of candidates.excel) {
    if (ref.title.trim() === '' || titleChars.length === 0) continue;
    const r = compareTexts(draft.title, ref.title, 'title', EXCEL_TITLE_THRESHOLD);
    if (!r.near) continue;
    out.push(
      violation('title', 'excel_title_copy', 'hard', `タイトルがExcel参考例（${ref.id}）のタイトル「${ref.title}」と同じかよく似ています（${similarityNote(r, EXCEL_TITLE_THRESHOLD)}）。参考例のタイトルはそのまま使えません。`, {
        actual: round(r.similarity),
        limit: r.method === 'edit_distance' ? 'edit_distance<=2' : EXCEL_TITLE_THRESHOLD,
        offending_text: draft.title,
      }),
    );
    break;
  }
  const ownRuns = [
    { field: primaryField, set: runs(primaryChars, EXCEL_COPY_RUN) },
    { field: 'title', set: runs(titleChars, EXCEL_COPY_RUN) },
  ];
  const copiedFields = new Set<string>();
  for (const ref of candidates.excel) {
    if (ref.comment === null) continue;
    const commentRuns = runs(comparisonChars(ref.comment), EXCEL_COPY_RUN);
    for (const { field, set } of ownRuns) {
      if (copiedFields.has(field)) continue;
      const run = [...commentRuns].find((r) => set.has(r));
      if (run === undefined) continue;
      copiedFields.add(field);
      out.push(
        violation(field, 'excel_comment_copy', 'hard', `${fieldJa(field)}に、Excel参考例（${ref.id}）のコメントと${EXCEL_COPY_RUN}文字以上続けて同じ部分があります: 「${run}」。参考例の文章は写さず、自分の言葉で書いてください。`, {
          limit: EXCEL_COPY_RUN,
          offending_text: run,
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- candidates

/** The posted-text history as the duplicate check reads it (HistoryStore). */
export interface HistoryReader {
  /** Newest first; `postType` null = every post type. */
  recentEntries(postType: PostType | null, n: number): readonly { job_id: string; post_type: PostType; title: string; primary_text: string }[];
  hashes(): readonly PostedHash[];
}

export interface DedupeReader {
  records(): readonly { job_id: string; post_type: PostType; title_hash: string | null; body_hash: string | null }[];
}

export interface DuplicateSources {
  history: HistoryReader;
  /** The job store: drafts of other jobs in READY / POSTING / VERIFYING / VERIFY_REQUIRED. */
  jobs: DraftJobReader;
  /** dedupe.json: hashes of posts whose history entry is gone (spec 16.5 keeps them for good). */
  dedupe?: DedupeReader;
}

/**
 * Everything to compare a job's draft with (spec 10.3): the last `recentPosts` posted texts of every post type, the
 * drafts of other jobs waiting to be posted, and the hashes of every posted text. Excel references come from the
 * generation context. The job itself is left out.
 */
export async function collectDuplicateCandidates(sources: DuplicateSources, o: { jobId: string; recentPosts: number; excel?: readonly ExcelReference[] }): Promise<DuplicateCandidates> {
  const texts: DuplicateText[] = sources.history
    .recentEntries(null, o.recentPosts)
    .filter((e) => e.job_id !== o.jobId)
    .map((e) => ({ origin: 'history', job_id: e.job_id, post_type: e.post_type, title: e.title, primary_text: e.primary_text }));
  const seen = new Set(texts.map((t) => t.job_id));
  for (const { id } of sources.jobs.summaries((s) => PENDING_DRAFT_STATUSES.has(s.status) && s.id !== o.jobId)) {
    if (seen.has(id)) continue;
    const job = await sources.jobs.get(id);
    if (job === null || !PENDING_DRAFT_STATUSES.has(job.status)) continue;
    const draft = DraftSchema.safeParse(job.draft);
    if (!draft.success) continue;
    texts.push({ origin: 'draft', job_id: job.id, post_type: job.post_type, title: draft.data.title, primary_text: primaryTextOf(draft.data) });
    seen.add(job.id);
  }
  const hashes = new Map<string, PostedHash>();
  for (const h of [...sources.history.hashes(), ...(sources.dedupe?.records() ?? [])]) {
    if (h.job_id === o.jobId || hashes.has(h.job_id)) continue;
    hashes.set(h.job_id, { job_id: h.job_id, post_type: h.post_type, title_hash: h.title_hash, body_hash: h.body_hash });
  }
  return { texts, hashes: [...hashes.values()], excel: [...(o.excel ?? [])] };
}
