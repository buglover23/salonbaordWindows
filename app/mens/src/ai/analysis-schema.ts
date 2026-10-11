import { z } from 'zod';
import { BANGS_TYPES, HAIR_LENGTHS, MODEL_INFO_VALUES, TEXTURES } from '../shared/types.js';

// Spec 6.2. Every key is required and "not known" is the enum value "unknown" (never null or a missing key), so the
// schema stays within structured-output limits: no optional keys, no unions. The API enforces the enums and the
// schema_version const (structured-schema.ts keeps them in the sent schema) but not numeric bounds, which the Zod parse
// checks. List lengths are not bounded in what the model may return: the analyzer keeps the first N instead of failing
// a whole answer over one extra item, and AnalysisSchema (the stored result) holds the caps.

// The value lists live in shared/types.ts so the page-profile protocol (mapped.* fields) can use them without this module.
export { BANGS_TYPES, HAIR_LENGTHS, MODEL_INFO_VALUES, TEXTURES };
export type HairLength = (typeof HAIR_LENGTHS)[number];

/** Colour families at the coarse grain a photo can support (spec 9.5: lighting changes fine shades). */
export const OBSERVED_COLOR_FAMILIES = [
  'ブラック系',
  'ブラウン系',
  'ベージュ系',
  'アッシュ系',
  'グレージュ系',
  'ピンク系',
  'レッド系',
  'オレンジ系',
  'ブルー系',
  'パープル系',
  'グリーン系',
  'ハイトーン',
  'その他',
  'unknown',
] as const;
export type ObservedColorFamily = (typeof OBSERVED_COLOR_FAMILIES)[number];

export const MAX_STYLE_FEATURES = 8;
export const MAX_IMPRESSIONS = 6;
export const MAX_SUGGESTED_CATEGORIES = 3;
export const MAX_UNKNOWNS = 8;
export const MAX_QUALITY_ISSUES = 8;

const confidence = z.number().min(0).max(1).describe('How sure the photo alone makes you, 0 to 1. An aid, not a probability.');

const attribute = <T extends z.ZodType>(value: T, description: string) => z.strictObject({ value, confidence }).describe(description);

const feature = attribute(z.string(), 'One visible cut, colour placement or styling feature, as a short Japanese phrase.');

/** What the model is asked for and what its answer is parsed with (lists unbounded, see above). */
export const AnalysisOutputSchema = z.strictObject({
  schema_version: z.literal(1),
  hair_length: attribute(z.enum(HAIR_LENGTHS), 'Visible hair length; "unknown" when the photo does not show it.'),
  observed_color: attribute(z.enum(OBSERVED_COLOR_FAMILIES), 'Visible hair colour family; "unknown" when lighting or filters make it unreliable.'),
  style_features: z.array(feature).describe(`At most ${MAX_STYLE_FEATURES}, most distinctive first.`),
  bangs: attribute(z.enum(BANGS_TYPES), 'Visible bangs (front hair); "unknown" when not visible.'),
  texture: attribute(z.enum(TEXTURES), 'Visible texture by appearance only; "perm" means a perm-like curl pattern, not a treatment fact.'),
  impressions: z.array(z.string()).describe(`At most ${MAX_IMPRESSIONS} short Japanese impression words.`),
  suggested_category_ids: z
    .array(z.string())
    .describe(`At most ${MAX_SUGGESTED_CATEGORIES} ids from the allowed category list in the request, best first; empty when none fits.`),
  unknowns: z.array(z.string()).describe(`At most ${MAX_UNKNOWNS}: what a post might need that the photo cannot show (Japanese).`),
  quality_issues: z.array(z.string()).describe(`At most ${MAX_QUALITY_ISSUES} problems that make the photo hard to judge (Japanese); empty when none.`),
  not_hair_photo: z.boolean().describe('true when the photo does not show a hairstyle.'),
  model_info: z
    .strictObject({
      hair_amount: attribute(z.enum(MODEL_INFO_VALUES.hair_amount), '髪量 as it looks.'),
      hair_texture: attribute(z.enum(MODEL_INFO_VALUES.hair_texture), '髪質 (softness) as it looks.'),
      thickness: attribute(z.enum(MODEL_INFO_VALUES.thickness), '太さ of a single hair as it looks.'),
      curl: attribute(z.enum(MODEL_INFO_VALUES.curl), 'クセ (natural wave) as it looks.'),
      face_shape: attribute(z.enum(MODEL_INFO_VALUES.face_shape), '顔型 as it looks.'),
      age_group: attribute(z.enum(MODEL_INFO_VALUES.age_group), '年代 as it looks.'),
    })
    .describe("The salon's SALON BOARD form choices for the model, estimated from appearance only; never used in any text."),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

/** The analysis the analyzer returns and a job stores: the model's answer after the deterministic checks and caps. */
export const AnalysisSchema = AnalysisOutputSchema.extend({
  style_features: z.array(feature).max(MAX_STYLE_FEATURES),
  impressions: z.array(z.string()).max(MAX_IMPRESSIONS),
  suggested_category_ids: z.array(z.string()).max(MAX_SUGGESTED_CATEGORIES),
  unknowns: z.array(z.string()).max(MAX_UNKNOWNS),
  quality_issues: z.array(z.string()).max(MAX_QUALITY_ISSUES),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
