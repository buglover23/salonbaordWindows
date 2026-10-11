import type { Draft } from '../../ai/draft-schemas.js';
import { checkDuplicates } from '../duplicates.js';
import type { ValidationContext, Violation } from '../types.js';

// Spec 10.1 step 8: Excel copies, posted titles and texts, and drafts waiting to be posted (duplicates.ts).

/** Group 8: exact and near duplicates and Excel copies, against the context's candidates and Excel examples. All hard. */
export function checkDuplicateRule(draft: Draft, ctx: ValidationContext): Violation[] {
  const { title_similarity_threshold, body_similarity_threshold } = ctx.snapshot.settings.duplicates;
  const excel = new Map(ctx.duplicates.excel.map((e) => [e.id, e]));
  for (const e of ctx.generation.examples) if (!excel.has(e.id)) excel.set(e.id, { id: e.id, title: e.title, comment: e.comment });
  return checkDuplicates(draft, { ...ctx.duplicates, excel: [...excel.values()] }, {
    titleThreshold: title_similarity_threshold,
    bodyThreshold: body_similarity_threshold,
    excludeJobId: ctx.job.id,
  });
}
