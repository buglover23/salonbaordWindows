import { systemClock, type Clock } from '../shared/clock.js';
import { appError } from '../shared/errors.js';
import type { Job } from '../shared/job-schema.js';
import { AUDIENCE_JA, POST_TYPE_JA } from '../shared/labels.js';
import type { ContentPipeline, ValidationOutcome } from './job-processor.js';

// A shipped categories.json style category id for each audience.
const MOCK_CATEGORY = { mens: 'two_block', ladies: 'short' } as const;

/**
 * Fixed content for dry-run before the real AI pipeline exists (Plan 2). It never touches the network and gives each
 * job its own text (the job id's last 6 characters) so the duplicate checks see distinct posts.
 */
export class MockContentPipeline implements ContentPipeline {
  readonly #failValidationTimes: number;
  readonly #clock: Clock;

  /**
   * `failValidationTimes`: how many validations of each job are rejected (with regenerate:true) before one passes. The count
   * comes from the job itself (its regeneration_count goes up by one per rejected validation), so nothing is kept per job.
   */
  constructor(o: { failValidationTimes?: number; clock?: Clock } = {}) {
    this.#failValidationTimes = o.failValidationTimes ?? 0;
    this.#clock = o.clock ?? systemClock;
  }

  // Same shape as the example in spec 6.2.
  async analyze(job?: Job): Promise<unknown> {
    return {
      schema_version: 1,
      hair_length: { value: 'medium', confidence: 0.91 },
      observed_color: { value: 'ブラウン系', confidence: 0.86 },
      style_features: [{ value: '顔周りレイヤー', confidence: 0.9 }],
      bangs: { value: 'unknown', confidence: 0.3 },
      impressions: ['柔らかい', '自然な動き'],
      suggested_category_ids: [MOCK_CATEGORY[job?.audience_category ?? 'ladies']],
      unknowns: ['実施した施術メニュー', 'ブリーチ履歴'],
      quality_issues: [],
    };
  }

  async generate(job: Job): Promise<unknown> {
    const suffix = job.id.slice(-6);
    const title = `【DRY-RUN】${AUDIENCE_JA[job.audience_category]}${POST_TYPE_JA[job.post_type]} ${suffix}`;
    const common = { keywords: ['ヘアコンサルティング', '似合わせカット'], hashtags: ['#ドライラン'], evidence_refs: [] };
    if (job.post_type === 'style') {
      return {
        post_type: 'style',
        title,
        menu_text: 'ドライラン用の仮のメニュー説明です。',
        stylist_comment: `ドライラン用の仮のコメントです（${suffix}）。実際の投稿には使われません。`,
        category_id: MOCK_CATEGORY[job.audience_category],
        ...common,
      };
    }
    return {
      post_type: 'blog',
      title,
      body: `ドライラン用の仮のブログ本文です（${suffix}）。実際の投稿には使われません。`,
      category_id: null,
      ...common,
    };
  }

  async validate(job: Job): Promise<ValidationOutcome> {
    const done = job.regeneration_count;
    if (done >= this.#failValidationTimes) return { ok: true };
    return {
      ok: false,
      regenerate: true,
      error: appError('VALIDATION_FAILED', 'validate', this.#clock, {
        message: `ドライラン用の模擬検証をわざと不合格にしました（${done + 1}回目）。`,
      }),
    };
  }
}
