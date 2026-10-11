import type { AiStage, AudienceCategory, MODEL_INFO_VALUES, ModelInfoKey, PostType } from './types.js';

// Operator-facing Japanese names for the value lists in types.ts.
export const POST_TYPE_JA: Record<PostType, string> = { style: 'スタイル', blog: 'ブログ' };

export const AUDIENCE_JA: Record<AudienceCategory, string> = { mens: 'メンズ', ladies: 'レディース' };

export const AI_STAGE_JA: Record<AiStage, string> = { analysis: '画像解析', generation: '文章生成', check: '整合性チェック' };

type Known<K extends ModelInfoKey> = Exclude<(typeof MODEL_INFO_VALUES)[K][number], 'unknown'>;

/** The style form's スタイルのモデル情報 radios as the real screen shows them (2026-10-06): the item and each value's label. */
export const MODEL_INFO_JA: { [K in ModelInfoKey]: { name: string; labels: Record<Known<K>, string> } } = {
  hair_amount: { name: '髪量', labels: { few: '少ない', normal: '普通', many: '多い' } },
  hair_texture: { name: '髪質', labels: { soft: '柔かい', normal: '普通', hard: '硬い' } },
  thickness: { name: '太さ', labels: { thin: '細い', normal: '普通', thick: '太い' } },
  curl: { name: 'クセ', labels: { none: 'なし', slight: '少し', strong: '強い' } },
  face_shape: { name: '顔型', labels: { inverted_triangle: '逆三角', round: '丸型', base: 'ベース', oval: '卵型', long: '面長', square: '四角' } },
  age_group: { name: '年代', labels: { kids: 'キッズ', teens: '10代', '20s': '20代', '30s': '30代', '40s': '40代', '50s': '50代', '60s_plus': '60代以上' } },
};

/** The side a copy's Chrome extension serves: its one audience (settings.audiences), or null for both. */
export const extensionSide = (audiences: readonly AudienceCategory[] | null): AudienceCategory | null => (audiences?.length === 1 ? audiences[0]! : null);

/** The extension's name for a copy: the manifest name, its default_title and the popup header. */
export function extensionName(audiences: readonly AudienceCategory[] | null): string {
  const side = extensionSide(audiences);
  return side === null ? 'サロン投稿アシスタント' : `サロン投稿アシスタント（${AUDIENCE_JA[side]}）`;
}

/** The extension sees another store logged in on SALON BOARD in its Chrome: what to do, per side. */
export function wrongLoginJa(shown: string, audiences: readonly AudienceCategory[] | null, expected: string): string {
  const side = extensionSide(audiences);
  const head = `この Chrome は「${shown}」でログインしています。`;
  if (side === null) return `${head}この拡張機能は「${expected}」用です。「${expected}」でログインした Chrome に入れてください。`;
  const [me, other] = [AUDIENCE_JA[side], AUDIENCE_JA[side === 'mens' ? 'ladies' : 'mens']];
  return `${head}この拡張機能は（${me}）用です。${me}の Chrome に入れるか、${other}の Chrome には（${other}）を入れてください。`;
}
