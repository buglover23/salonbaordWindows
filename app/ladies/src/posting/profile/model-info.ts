import { AnalysisSchema } from '../../ai/analysis-schema.js';
import type { Job } from '../../shared/job-schema.js';
import type { Field, OptionRef } from '../../shared/protocol/profile.js';
import type { ModelInfoKey } from '../../shared/types.js';

/** The profile's model_info.* fields and the analysis item each is filled from. */
const ITEM: Record<string, ModelInfoKey> = {
  'model_info.volume': 'hair_amount',
  'model_info.texture': 'hair_texture',
  'model_info.thickness': 'thickness',
  'model_info.curl': 'curl',
  'model_info.face': 'face_shape',
  'model_info.age': 'age_group',
};

/**
 * Option keys in a profile are letters only (^[a-z_]{1,20}$) and `none` is 設定しない, so the other analysis values that
 * would clash are spelled out; every other value is the option key itself (few, normal, many, soft, ..., kids, teens).
 */
const OPTION_KEY: Record<string, string> = {
  none: 'none_curl', // curl: なし (the page value 1), not 設定しない (99)
  '20s': 'twenties',
  '30s': 'thirties',
  '40s': 'forties',
  '50s': 'fifties',
  '60s_plus': 'sixties_plus',
};

/**
 * P3-R50: the option a `model_info.*` radio gets from the job's image analysis: the profile's option for the analysed value
 * when the AI is at least `min` sure, otherwise (unknown, unsure, no such option, no readable analysis) 設定しない (`none`).
 */
export function modelInfoOption(key: string, field: Field, job: Pick<Job, 'analysis'>, min: number): OptionRef | undefined {
  const item = ITEM[key];
  const analysis = AnalysisSchema.safeParse(job.analysis);
  if (item === undefined || !analysis.success) return field.options?.none;
  const { value, confidence } = analysis.data.model_info[item];
  return (value === 'unknown' || confidence < min ? undefined : field.options?.[OPTION_KEY[value] ?? value]) ?? field.options?.none;
}
