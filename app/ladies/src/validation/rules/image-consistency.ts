import type { HairLength, ObservedColorFamily } from '../../ai/analysis-schema.js';
import { primaryFieldOf, primaryTextOf, type Draft } from '../../ai/draft-schemas.js';
import { compactKey, containsTerm, scanTerms } from '../scan.js';
import { fieldJa, quoted, violation, type DraftField, type ValidationContext, type Violation } from '../types.js';

// Spec 10.1 step 5 / 9.1 / 9.5: the text never states a colour, a length or anything the photo analysis could not see.
// Colour and length words come from keywords.json (color_terms, style_terms); the longest word found counts, so
// アッシュグレージュ is one colour name, not also アッシュ.

const LENGTH_JA: Record<HairLength, string> = {
  very_short: 'ベリーショート',
  short: 'ショート',
  bob: 'ボブ',
  medium: 'ミディアム',
  long: 'ロング',
  very_long: 'スーパーロング',
  unknown: '不明',
};

/**
 * What the analysis may list as unknown (analysis.unknowns) and the words that would state it anyway. An unknowns entry
 * holding a trigger makes those words claims about something nobody verified. Only wording that is a claim by nature;
 * the AI consistency check judges the rest.
 */
export const UNKNOWN_CLAIMS: readonly { triggers: readonly string[]; words: readonly string[]; label: string }[] = [
  { triggers: ['ブリーチ'], words: ['ブリーチ'], label: 'ブリーチの有無' },
  { triggers: ['薬剤', '薬液'], words: ['薬剤', '薬液', 'カラー剤', 'パーマ液', 'ノンジアミン', 'オーガニックカラー'], label: '使用した薬剤' },
  { triggers: ['レシピ', '配合'], words: ['レシピ', '配合'], label: 'カラーのレシピ' },
  { triggers: ['施術'], words: ['施術済', '施術しました', '施術しています', '施術後'], label: '実施した施術' },
];

/** Fields checked: the title, the primary text, the menu text the model chose (not a sidecar-fixed one), each hashtag. */
function checkedFields(draft: Draft, ctx: ValidationContext): DraftField[] {
  const fields: DraftField[] = [
    { field: 'title', text: draft.title },
    { field: primaryFieldOf(draft.post_type), text: primaryTextOf(draft) },
  ];
  if (draft.post_type === 'style' && ctx.generation.menus?.mode === 'choose') fields.push({ field: 'menu_text', text: draft.menu_text });
  for (const t of draft.hashtags) fields.push({ field: 'hashtags', text: t });
  return fields;
}

/** Words found per field (hashtags merged into one entry). */
function collect(fields: readonly DraftField[], find: (text: string) => string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of fields) {
    const found = find(f.text);
    if (found.length === 0) continue;
    out.set(f.field, [...new Set([...(out.get(f.field) ?? []), ...found])]);
  }
  return out;
}

/** Families a colour name belongs to (compared by compactKey). */
function familiesOf(term: string, dictionary: Partial<Record<string, string[]>>): string[] {
  const k = compactKey(term);
  return Object.entries(dictionary)
    .filter(([, words]) => (words ?? []).some((w) => compactKey(w) === k))
    .map(([family]) => family);
}

/** Group 5: color_mismatch, length_mismatch, unknown_attribute_claim. All hard. */
export function checkImageConsistency(draft: Draft, ctx: ValidationContext): Violation[] {
  const out: Violation[] = [];
  const { analysis } = ctx.generation;
  const fields = checkedFields(draft, ctx);
  const colorDict = ctx.snapshot.keywords.color_terms;
  const lengthDict = ctx.snapshot.keywords.style_terms;

  // Colour names: only those of the observed family; none while the family is unknown or その他.
  const family: ObservedColorFamily = analysis.observed_color.value;
  const colorWords = Object.values(colorDict).flatMap((w) => w ?? []);
  for (const [field, terms] of collect(fields, (t) => scanTerms(t, colorWords, { key: compactKey }))) {
    const wrong = terms.filter((term) => family === 'unknown' || family === 'その他' || !familiesOf(term, colorDict).includes(family));
    if (wrong.length === 0) continue;
    const reason =
      family === 'unknown' || family === 'その他'
        ? `写真の髪色は系統まで判定できていない（${family === 'unknown' ? '不明' : 'その他'}）ため、具体的な色名は書けません: ${quoted(wrong)}。`
        : `写真の髪色（${family}）と違う系統の色名があります: ${wrong.map((w) => `「${w}」（${familiesOf(w, colorDict).join('・')}）`).join('')}。写真で見える色の系統の言葉にしてください。`;
    out.push(violation(field, 'color_mismatch', 'hard', `${fieldJa(field)}: ${reason}`, { actual: wrong.join('、'), limit: family, offending_text: wrong.join(' ') }));
  }

  // Length words: only those of the analysed length; none while it is unknown.
  const length: HairLength = analysis.hair_length.value;
  const lengthWords = Object.values(lengthDict).flatMap((w) => w ?? []);
  const fits = (term: string): boolean => {
    if (length === 'unknown') return false;
    const k = compactKey(term);
    return (lengthDict[length] ?? []).some((w) => compactKey(w) === k);
  };
  for (const [field, terms] of collect(fields, (t) => scanTerms(t, lengthWords, { key: compactKey }))) {
    const wrong = terms.filter((t) => !fits(t));
    if (wrong.length === 0) continue;
    const reason =
      length === 'unknown'
        ? `写真から髪の長さが判定できていないため、長さを示す言葉は書けません: ${quoted(wrong)}。`
        : `写真の髪の長さ（${LENGTH_JA[length]}）と合わない長さの言葉があります: ${quoted(wrong)}。`;
    out.push(violation(field, 'length_mismatch', 'hard', `${fieldJa(field)}: ${reason}`, { actual: wrong.join('、'), limit: length, offending_text: wrong.join(' ') }));
  }

  // What the analysis lists as unknown is never stated. Only what the context verified for this photo covers it: the
  // phrases of the category the sidecar's category_hint confirmed (verified_treatments, ruling P2-R15), never a menu name.
  const unknownClaims = UNKNOWN_CLAIMS.filter((c) => analysis.unknowns.some((u) => c.triggers.some((t) => containsTerm(u, t))));
  if (unknownClaims.length > 0) {
    const covers = ctx.generation.verified_treatments;
    for (const claim of unknownClaims) {
      for (const [field, terms] of collect(fields, (t) => scanTerms(t, claim.words, { covers }))) {
        out.push(
          violation(
            field,
            'unknown_attribute_claim',
            'hard',
            `${fieldJa(field)}: 画像解析で「分からない」とされた${claim.label}について書いています: ${quoted(terms)}。確認できていないことは書かないでください。`,
            { offending_text: terms.join(' ') },
          ),
        );
      }
    }
  }
  return out;
}
