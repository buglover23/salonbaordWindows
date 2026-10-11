import type { HairLength, ObservedColorFamily } from '../ai/analysis-schema.js';

// Word lists the Validator (Plan 2 Task 8) checks drafts with. The shipped config/keywords.json carries the same lists
// for the owner to edit; these are used when a key is missing there.

/** Colour families a colour name can belong to (spec 9.5); unknown and その他 have no names. */
export type ColorFamilyKey = Exclude<ObservedColorFamily, 'unknown'>;
/** Hair lengths a style word can assert (spec 9.5). */
export type LengthKey = Exclude<HairLength, 'unknown'>;

export const RESTRICTION_KINDS = ['formal_skeletal_diagnosis', 'verified_menu', 'never'] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export interface RestrictedTerm {
  term: string;
  /**
   * formal_skeletal_diagnosis: only while salon.service_claims.formal_skeletal_diagnosis is true;
   * verified_menu: only when the photo's sidecar menus or its confirmed category verify it (a menu the model chose is
   *   no evidence);
   * never: an assertion or guarantee that is never written.
   */
  allowed_only_if: RestrictionKind;
  note: string;
}

export interface NgWordException {
  term: string;
  /** A literal phrase containing `term`: an occurrence of the term inside this phrase is not a violation (必ずしも). */
  context_pattern: string;
}

/**
 * Colour names by family (spec 9.5). A name may belong to several families (ピンクベージュ: ピンク系 and ベージュ系); the
 * longest name found wins over the shorter ones inside it. 暖色・寒色・くすみ・透明感・艶 describe a style, not a family,
 * and words that are often not about hair colour (bare オリーブ, ラベンダー, ホワイト, マット) are left out.
 */
export const DEFAULT_COLOR_TERMS: Record<ColorFamilyKey, string[]> = {
  ブラック系: ['ブラック', '黒髪', 'ブルーブラック', 'アッシュブラック', 'グレーブラック', 'ネイビーブラック'],
  ブラウン系: [
    'ブラウン',
    '茶髪',
    'ショコラブラウン',
    'ココアブラウン',
    'チョコレートブラウン',
    'チョコブラウン',
    'ダークブラウン',
    'ナチュラルブラウン',
    'マロンブラウン',
    'アッシュブラウン',
    'ピンクブラウン',
    'オレンジブラウン',
    'ブラウンベージュ',
  ],
  ベージュ系: ['ベージュ', 'ミルクティーベージュ', 'ミルクティー', 'ピンクベージュ', 'ラベンダーベージュ', 'オリーブベージュ', 'グレーベージュ', 'ブラウンベージュ', 'ホワイトベージュ'],
  アッシュ系: ['アッシュ', 'アッシュグレージュ', 'アッシュブラック', 'アッシュブラウン', 'ブルーアッシュ', 'グレーアッシュ', 'シルバーアッシュ', 'ラベンダーアッシュ', 'オリーブアッシュ'],
  グレージュ系: ['グレージュ', 'アッシュグレージュ', 'ラベンダーグレージュ', 'オリーブグレージュ', 'ミルクティーグレージュ', 'ピンクグレージュ', 'グレーベージュ'],
  ピンク系: ['ピンク', 'ピンクベージュ', 'ピンクブラウン', 'ピンクグレージュ', 'チェリーピンク'],
  レッド系: ['レッド', '赤髪', 'ワインレッド', 'チェリーレッド', 'ボルドー', 'カシス'],
  オレンジ系: ['オレンジ', 'オレンジブラウン', 'カッパー', 'アプリコット'],
  ブルー系: ['ブルー', 'ネイビー', 'ブルーブラック', 'ネイビーブラック', 'ブルーアッシュ'],
  パープル系: ['パープル', 'バイオレット', 'ラベンダーカラー', 'ラベンダーベージュ', 'ラベンダーグレージュ', 'ラベンダーアッシュ', 'ボルドー', 'カシス'],
  グリーン系: ['グリーン', 'カーキ', 'オリーブカラー', 'オリーブベージュ', 'オリーブグレージュ', 'オリーブアッシュ'],
  ハイトーン: ['ハイトーン', 'ホワイトブロンド', 'ブロンド', 'シルバー', 'シルバーアッシュ', 'ペールトーン', 'ホワイトベージュ'],
  その他: [],
};

/**
 * Style words that state a length (spec 9.5), by the analysis' hair_length. A word may fit several lengths (ショートボブ:
 * short and bob); the longest word found wins over the shorter ones inside it (ショートボブ is not also ショート).
 */
export const DEFAULT_STYLE_TERMS: Record<LengthKey, string[]> = {
  very_short: ['ベリーショート', 'ショート', 'ショートヘア', 'ショートカット', 'ハンサムショート', '坊主', 'ボウズ', 'バズカット'],
  short: ['ショート', 'ショートヘア', 'ショートカット', 'ハンサムショート', 'ショートボブ', 'ショートレイヤー', 'ショートウルフ', 'マッシュショート', 'ミニウルフ'],
  bob: ['ボブ', 'ショートボブ', 'ミニボブ', '外ハネボブ', '前下がりボブ', 'レイヤーボブ', 'ボブウルフ', 'タンバルモリ', 'ロブ', 'ミニウルフ'],
  medium: ['ミディアム', 'ミディ', 'セミディ', 'レイヤーミディ', 'ミディアムレイヤー', 'ミディアムウルフ', 'ロブ', 'セミロング', 'ヨシンモリ'],
  long: ['ロング', 'ロングヘア', 'セミロング', 'レイヤーロング', 'ロングレイヤー', 'ヨシンモリ'],
  very_long: ['ロング', 'ロングヘア', 'スーパーロング', 'レイヤーロング', 'ロングレイヤー', 'ヨシンモリ'],
};

const SKELETAL_NOTE = '店が正式な骨格診断を行っている（salon.json の service_claims.formal_skeletal_diagnosis が true）ときだけ書けます';
const MENU_NOTE = '写真だけでは分からない施術です。その写真の sidecar.json のメニュー（verified_menu_ids）か確認済みカテゴリーで裏付けられたときだけ書けます';
const NEVER_NOTE = '断定・効果の保証になるため書きません';

/**
 * Spec 9.3 / 9.4 / 6.2: wording that needs a verified fact, and guarantees that are never written. The verified_menu
 * terms join the generation context's treatment list (treatmentTerms), so the context, the prompt and the Validator
 * share one list; the never terms join its forbidden_words.
 */
export const DEFAULT_RESTRICTED_TERMS: RestrictedTerm[] = [
  { term: '骨格診断', allowed_only_if: 'formal_skeletal_diagnosis', note: SKELETAL_NOTE },
  ...[
    '髪質改善',
    '縮毛矯正',
    'ストレートパーマ',
    'デジタルパーマ',
    'ブリーチ',
    '白髪染め',
    '酸熱トリートメント',
    'ケラチントリートメント',
    'TOKIOトリートメント',
    '水素トリートメント',
    'ノンジアミン',
    'オーガニックカラー',
  ].map((term): RestrictedTerm => ({ term, allowed_only_if: 'verified_menu', note: MENU_NOTE })),
  ...['絶対', '必ず', '100%', '100パーセント', '確実に', '骨格が変わる', '骨格そのものが変わる', '小顔になる', '誰でも似合う', '劇的'].map(
    (term): RestrictedTerm => ({ term, allowed_only_if: 'never', note: NEVER_NOTE }),
  ),
];

/** Spec 5.5: context-dependent exceptions to the NG words (正規化後の部分一致). */
export const DEFAULT_NG_WORD_EXCEPTIONS: NgWordException[] = [{ term: '必ず', context_pattern: '必ずしも' }];
