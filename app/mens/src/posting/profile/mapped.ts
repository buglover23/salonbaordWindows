import { AnalysisSchema } from '../../ai/analysis-schema.js';
import type { Field, OptionRef } from '../../shared/protocol/profile.js';
import type { Job } from '../../shared/job-schema.js';

/**
 * P3-R46: the option a `mapped.*` field gets from the job's image analysis (only MAPPABLE_SOURCES). `unknown` (the photo
 * does not show it, the value has no approved option, or no readable analysis) holds the job: CONFIG_INCOMPLETE.
 */
export function mappedOption(field: Field, job: Pick<Job, 'analysis'>): OptionRef | { unknown: true } {
  const analysis = AnalysisSchema.safeParse(job.analysis);
  if (field.map === undefined || !analysis.success) return { unknown: true };
  const source = field.map.source;
  const value = (source === 'analysis.hair_length' ? analysis.data.hair_length : source === 'analysis.bangs' ? analysis.data.bangs : analysis.data.texture).value;
  return (value === 'unknown' ? undefined : field.map.options[value]) ?? { unknown: true };
}
