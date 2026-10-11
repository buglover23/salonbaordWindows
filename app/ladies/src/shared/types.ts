// Value lists are the single source for both the TypeScript unions and the Zod enums in job-schema.ts.

export const POST_TYPES = ['style', 'blog'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const AUDIENCE_CATEGORIES = ['mens', 'ladies'] as const;
export type AudienceCategory = (typeof AUDIENCE_CATEGORIES)[number];

export const JOB_STATUSES = [
  'PENDING',
  'ANALYZING',
  'GENERATING',
  'VALIDATING',
  'READY',
  'POSTING',
  'VERIFYING',
  'POSTED',
  'FAILED',
  'RETRY_WAIT',
  'BLOCKED',
  'VERIFY_REQUIRED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const SUBMISSION_STATES = [
  'not_started',
  'intent_recorded',
  'confirmed',
  'definitely_not_submitted',
  'unknown',
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const MODES = ['dry_run', 'live'] as const;
export type Mode = (typeof MODES)[number];
/** The dispatch reason of dry-run; status, the 起動.bat banner and the popup leave it out (dry-run pseudo-posts by itself). */
export const DRY_RUN_JA = 'dry-run のため SALON BOARD には投稿しません。';

/** The three kinds of AI call (Plan 2 decision 1); each has its own model and effort in settings.ai. */
export const AI_STAGES = ['analysis', 'generation', 'check'] as const;
export type AiStage = (typeof AI_STAGES)[number];

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

// Image analysis attributes (spec 6.2); also the sources of page-profile `mapped.*` fields (Plan 3 P3-R46).
export const HAIR_LENGTHS = ['very_short', 'short', 'bob', 'medium', 'long', 'very_long', 'unknown'] as const;
export const BANGS_TYPES = ['none', 'see_through', 'full', 'side', 'center_part', 'unknown'] as const;
/** How the hair looks; "perm" is a perm-like curl pattern by appearance only, never a claim that a perm was done. */
export const TEXTURES = ['straight', 'wave', 'curl', 'perm', 'unknown'] as const;

/**
 * スタイルのモデル情報 (ruling P3-R50): the visible-appearance estimate the salon's own SALON BOARD style form asks for.
 * It only fills that form's radios (labels in labels.ts MODEL_INFO_JA); it never reaches the text pipeline.
 */
export const MODEL_INFO_VALUES = {
  hair_amount: ['few', 'normal', 'many', 'unknown'],
  hair_texture: ['soft', 'normal', 'hard', 'unknown'],
  thickness: ['thin', 'normal', 'thick', 'unknown'],
  curl: ['none', 'slight', 'strong', 'unknown'],
  face_shape: ['inverted_triangle', 'round', 'base', 'oval', 'long', 'square', 'unknown'],
  age_group: ['kids', 'teens', '20s', '30s', '40s', '50s', '60s_plus', 'unknown'],
} as const;
export type ModelInfoKey = keyof typeof MODEL_INFO_VALUES;
