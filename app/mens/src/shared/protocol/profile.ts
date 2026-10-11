import { z } from 'zod';
import { AUDIENCE_CATEGORIES, BANGS_TYPES, HAIR_LENGTHS, POST_TYPES, TEXTURES } from '../types.js';
import { DateKeySchema, Sha256HexSchema } from './version.js';
import { UrlMatchSchema } from './url-match.js';

// Page profiles (config/salonboard_fields.json → pages): what the extension knows about each SALON BOARD page.
// Profile strings are untrusted data: CSS selectors are only ever passed to querySelector, never evaluated.

const css = z.string().min(1).max(300);

export const LocatorSchema = z.strictObject({
  css,
  within: css.optional(),
  /** A same-origin iframe only. */
  frame: css.optional(),
  text_equals: z.string().max(100).optional(),
  label_equals: z.string().max(100).optional(),
});
/** Candidates; every candidate that resolves must agree on ONE element (the engine decides, never the first match). */
export const LocatorSetSchema = z.array(LocatorSchema).min(1).max(5);
export type LocatorSet = z.infer<typeof LocatorSetSchema>;

export const SignalSchema = z.strictObject({
  locators: LocatorSetSchema,
  text_includes: z.string().max(100).optional(),
  attr: z.strictObject({ name: z.string().regex(/^[a-z][a-z0-9-]*$/), equals: z.string().max(100) }).optional(),
  state: z.enum(['present', 'absent', 'checked', 'selected']).default('present'),
});
export type Signal = z.infer<typeof SignalSchema>;
export const AllOfSchema = z.strictObject({ all_of: z.array(SignalSchema).min(1).max(8) });
export type AllOf = z.infer<typeof AllOfSchema>;
export const AnyOfSchema = z.strictObject({ any_of: z.array(SignalSchema).min(1).max(8) });

export const OptionRefSchema = z
  .strictObject({ value: z.string().max(200).optional(), text: z.string().max(100).optional() })
  .refine((o) => o.value !== undefined || o.text !== undefined, '選択肢は value か text のどちらかで指定してください');
export type OptionRef = z.infer<typeof OptionRefSchema>;

/** Job attributes a `mapped.*` field may take its option from (P3-R46), with their values. */
export const MAPPABLE_SOURCES = ['analysis.hair_length', 'analysis.bangs', 'analysis.texture'] as const;
export type MappableSource = (typeof MAPPABLE_SOURCES)[number];
export const MAPPABLE_SOURCE_VALUES: Record<MappableSource, readonly string[]> = {
  'analysis.hair_length': HAIR_LENGTHS,
  'analysis.bangs': BANGS_TYPES,
  'analysis.texture': TEXTURES,
};

/**
 * Logical field names: the fixed list, plus the families model_info.* (a radio filled from the photo's analysis, else none; P3-R50), fixed.* (owner-approved constant),
 * mapped.* (from a job attribute) and treatment.* (a treatment checkbox, checked only when the photo's sidecar
 * category_hint confirms one of its categories, ruling P2-R15; e.g. the style page's メニュー内容 パーマ / ブリーチ).
 */
export const LOGICAL_FIELD = /^(title|menu_text|stylist_comment|body|hashtags|category|audience|staff|feature|apply_image|coupon|image|(?:model_info|fixed|mapped|treatment)\.[a-z0-9_]{1,30})$/;

export const FieldSchema = z.strictObject({
  locators: LocatorSetSchema,
  kind: z.enum(['text', 'textarea', 'contenteditable', 'select', 'checkbox', 'checkbox_group', 'radio_group', 'tab', 'file']),
  required: z.boolean(),
  events: z.array(z.enum(['input', 'change', 'blur', 'keyup'])).max(4).default(['input', 'change']),
  /** Logical option → page option, e.g. none, mens, ladies. */
  options: z.record(z.string().regex(/^[a-z_]{1,20}$/), OptionRefSchema).optional(),
  /** Exactly for 'fixed.*' keys: the owner-approved constant. */
  fixed_option: OptionRefSchema.optional(),
  /** Exactly for 'mapped.*' keys: the owner-approved mapping from a job attribute. */
  map: z.strictObject({ source: z.enum(MAPPABLE_SOURCES), options: z.record(z.string(), OptionRefSchema) }).optional(),
  /** Exactly for 'treatment.*' checkboxes: the categories.json ids whose confirmation (sidecar category_hint) allows checking it. */
  confirmed_by: z.array(z.string().min(1).max(64)).min(1).max(10).optional(),
  /** Setting it reloads the page (P3-R40). */
  reloads_page: z.boolean().default(false),
  wait_options_ms: z.number().int().min(0).max(10_000).default(0),
  /** contenteditable only: the hidden control the page sends (nicEdit's textarea); the editor's HTML is copied into it. */
  mirror: LocatorSetSchema.optional(),
});
export type Field = z.infer<typeof FieldSchema>;

const LimitSchema = z.strictObject({
  max_length: z.number().int().positive(),
  count_unit: z.enum(['utf16', 'codepoint', 'grapheme', 'bytes']),
  newline_weight: z.union([z.literal(1), z.literal(2)]).default(2),
  /** A separate cap on line breaks (the blog body: 改行80回以下). */
  max_newlines: z.number().int().nonnegative().optional(),
});

const posInt = z.number().int().positive();

export const PageProfileSchema = z
  .strictObject({
    post_type: z.enum(POST_TYPES),
    audiences: z.array(z.enum(AUDIENCE_CATEGORIES)).min(1),
    /**
     * by_page: one page per audience (identified on the page); by_field: one page, the audience chosen in fields.audience
     * (the style page's カテゴリ radio); none: one page with no audience control (blog), every listed audience posts there.
     */
    audience_mode: z.enum(['by_page', 'by_field', 'none']),
    adapter_version: z.string(),
    encoding: z.enum(['utf-8', 'shift_jis', 'windows-31j']),
    url_match: UrlMatchSchema,
    page_identification: AllOfSchema,
    salon_identification: z.strictObject({ locators: LocatorSetSchema, match: z.literal('expected_account_label') }),
    poster: z
      .discriminatedUnion('mode', [
        z.strictObject({ mode: z.literal('staff_field') }),
        z.strictObject({ mode: z.literal('display'), locators: LocatorSetSchema }),
        z.strictObject({ mode: z.literal('absent_on_screen') }),
      ])
      .nullable()
      .default(null),
    audience_identification: z.strictObject({ mens: AllOfSchema.optional(), ladies: AllOfSchema.optional() }),
    fields: z.record(z.string().regex(LOGICAL_FIELD), FieldSchema, {
      error: (iss) => (iss.code === 'invalid_key' ? '欄の名前が不正です（決められた論理名か、model_info. / fixed. / mapped. で始まる名前にしてください）' : undefined),
    }),
    limits: z.partialRecord(z.enum(['title', 'menu_text', 'stylist_comment', 'body', 'hashtags']), LimitSchema),
    image: z.strictObject({
      formats: z.array(z.enum(['jpeg', 'png'])).min(1),
      max_bytes: posInt,
      max_width: posInt,
      max_height: posInt,
      min_width: posInt.optional(),
      min_height: posInt.optional(),
      max_count: posInt,
      preview: AnyOfSchema,
      preview_timeout_ms: z.number().int().min(5000).max(120_000).default(60_000),
      /**
       * The real SALON BOARD pages attach images through an uploader dialog: click `open` (the image slot / 画像アップロード),
       * set the file on fields.image (the dialog's file input), wait for `thumbnail` inside the dialog, click `submit`
       * (the dialog's 登録する, which only puts the image into the slot or body), then `preview` must show on the page.
       * The dialog's file input is not on the page until `open` is clicked, so fields.image must be `required: false`.
       */
      modal: z
        .strictObject({
          open: LocatorSetSchema,
          thumbnail: AnyOfSchema,
          submit: LocatorSetSchema,
          /** The dialog's 登録する reloads the whole page (the style page does); the new document finds the image in place. */
          reloads_page: z.boolean().default(false),
        })
        .optional(),
    }),
    hashtag: z.strictObject({
      placement: z.enum(['dedicated_field', 'append_to_primary_text', 'unsupported']),
      max_count: posInt.nullable(),
      with_hash_sign: z.boolean(),
      separator: z.enum([' ', '\n']),
      /** Characters per tag (the style page's tag input: 0/20). */
      max_tag_length: posInt.nullable().default(null),
      /** Tags entered one at a time: type one into fields.hashtags, then click this (「ハッシュタグを追加」). */
      add_button: LocatorSetSchema.optional(),
      /** The added tags as shown (one element per tag; many by design), for the read-back. Required with add_button. */
      added_items: LocatorSetSchema.optional(),
    }),
    /**
     * The style page's coupon dialog (クーポン選択), loaded by clicking `open`: choose the `items` entry whose `name` equals
     * the configured coupon (salon.json coupons), click its `radio`, then `submit` (設定する; `close` when none matches);
     * `value` (the hidden input the page fills) must then hold the radio's value.
     */
    coupon: z
      .strictObject({
        open: LocatorSetSchema,
        /** Matches many by design. */
        items: css,
        name: css,
        /** The item's radio, whose value is the coupon id the page then holds in `value` (style page). */
        radio: css.optional(),
        /**
         * The part of the item to click. With a radio (the real style page hides it inside the coupon's label, and only a
         * click on the coupon enables 設定する) the id is still read from the radio; without one (blog page) the choice is
         * read back from `chosen` and a non-empty `value`.
         */
        pick: css.optional(),
        /** With `pick`: where the page shows the chosen coupon's name after 設定する. */
        chosen: LocatorSetSchema.optional(),
        submit: LocatorSetSchema,
        close: LocatorSetSchema.optional(),
        value: LocatorSetSchema,
      })
      .optional(),
    /**
     * The irreversible click, guarded by the Node permission, is `confirm.locators` for in_page and confirm_page, else
     * `submit.locators`. confirm_page (the blog's 「確認する」 → confirmation page → final register button): the first click
     * is not a submission, but the new document must identify as the confirmation page; anything else after the first
     * input is an unexpected navigation (P3-R40).
     */
    submit: z.strictObject({
      locators: LocatorSetSchema,
      confirm: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('none') }),
        z.strictObject({ kind: z.literal('in_page'), locators: LocatorSetSchema }),
        z.strictObject({ kind: z.literal('native_confirm'), message_includes: z.string().max(100) }),
        z.strictObject({ kind: z.literal('confirm_page'), url_match: UrlMatchSchema.optional(), page_identification: AllOfSchema, locators: LocatorSetSchema }),
      ]),
    }),
    success_signals: z.strictObject({
      /** all_of; empty = not yet authored (a readiness item). */
      completion: z.array(SignalSchema).max(8),
      completion_url_match: UrlMatchSchema.optional(),
      /**
       * Owner-confirmed, for a list that cannot show the post (no dates, the newest on the last of many pages, details
       * behind script links): the completion page alone proves it, with completion_url_match and the own salon identified
       * on that page. The owner's verified_hash covers this flag.
       */
      completion_only: z.boolean().optional(),
      /** Default: profile.salon_identification. */
      salon_identification: z.strictObject({ locators: LocatorSetSchema }).optional(),
      list: z
        .strictObject({
          url: z.string().max(2048),
          url_match: UrlMatchSchema,
          item: z.strictObject({
            /** Matches many by design. */
            container: LocatorSetSchema,
            title: css,
            date: css.optional(),
            date_format: z.string().regex(/^[YMDHm年月日時分:/\- .]+$/).max(30).optional(),
            link: css.optional(),
            /** Restricted: a literal plus one (\d+) or ([A-Za-z0-9_-]+) group (compiled by the engine). */
            remote_id_pattern: z.string().max(100).optional(),
            title_may_truncate: z.boolean().default(false),
          }),
          next_page: LocatorSetSchema.optional(),
          max_pages: z.number().int().min(1).max(5).default(3),
        })
        .nullable(),
      detail: z.strictObject({ url_match: UrlMatchSchema, title: LocatorSetSchema, body: LocatorSetSchema }).optional(),
    }),
    failure_signals: z.strictObject({
      login: AnyOfSchema.optional(),
      mfa: AnyOfSchema.optional(),
      captcha: AnyOfSchema.optional(),
      account_error: AnyOfSchema.optional(),
      limit_reached: AnyOfSchema.extend({ limit_period: z.enum(['daily', 'monthly', 'total', 'unknown']).default('unknown') }).optional(),
      /** client_side_only is owner-confirmed only (P3-R14). */
      submit_rejected: AnyOfSchema.extend({ client_side_only: z.boolean().default(false) }).optional(),
      upload_error: AnyOfSchema.optional(),
    }),
    count_display: z
      .strictObject({ locators: LocatorSetSchema, pattern: z.enum(['first_integer', 'a_of_b']), kind: z.enum(['total', 'daily', 'monthly']) })
      .optional(),
    /**
     * 反映申請: a registered style is not public until it is pressed on 掲載管理TOP. After a post is proved, the SW opens `url` and
     * presses `button` once (the landing page must match `done_url_match`). It publishes every pending change, so a failure never
     * changes the post's result (a warning only) and the next post's 反映申請 publishes again.
     */
    publish: z.strictObject({ url: z.string().max(2048), url_match: UrlMatchSchema, button: LocatorSetSchema, done_url_match: UrlMatchSchema }).optional(),
    owner_attestations: z
      .strictObject({ poster_absent_on: DateKeySchema.nullable().default(null), model_info_absent_on: DateKeySchema.nullable().default(null) })
      .default({ poster_absent_on: null, model_info_absent_on: null }),
    /** The day the OWNER confirmed this profile on the real screen. */
    verified_at: z.string().min(1).nullable(),
    /** profileHash at that confirmation (P3-R37); any later edit voids the verification. */
    verified_hash: Sha256HexSchema.nullable().default(null),
    notes: z.string().max(500).optional(),
  })
  .superRefine((p, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    if (p.audience_mode === 'by_page') {
      const [only] = p.audiences;
      if (p.audiences.length !== 1 || only === undefined) issue(['audiences'], 'audience_mode が by_page のときは audiences を1つだけ書いてください');
      else if (p.audience_identification[only] === undefined) issue(['audience_identification', only], `${only} の画面を見分ける条件（audience_identification.${only}）が必要です`);
    } else if (p.audience_mode === 'none') {
      if (p.fields.audience !== undefined) issue(['fields', 'audience'], 'audience_mode が none（画面に対象の欄が無い）のときは fields.audience を書けません');
    } else {
      const field = p.fields.audience;
      if (field === undefined) issue(['fields', 'audience'],'audience_mode が by_field のときは対象を選ぶ欄（fields.audience）が必要です');
      for (const a of p.audiences) {
        if (field !== undefined && field.options?.[a] === undefined) issue(['fields', 'audience', 'options', a], `fields.audience.options に ${a} の選択肢が必要です`);
        if (p.audience_identification[a] === undefined) issue(['audience_identification', a], `${a} の画面を見分ける条件（audience_identification.${a}）が必要です`);
      }
    }
    const dedicated = p.hashtag.placement === 'dedicated_field';
    if (dedicated && p.fields.hashtags === undefined) issue(['hashtag', 'placement'], 'ハッシュタグ専用欄（dedicated_field）には fields.hashtags が必要です');
    if (!dedicated && p.fields.hashtags !== undefined) issue(['fields', 'hashtags'], 'fields.hashtags は hashtag.placement が dedicated_field のときだけ書けます');
    if (p.hashtag.add_button !== undefined && !dedicated) issue(['hashtag', 'add_button'], 'add_button は hashtag.placement が dedicated_field のときだけ書けます');
    if ((p.hashtag.add_button === undefined) !== (p.hashtag.added_items === undefined)) {
      issue(['hashtag', 'added_items'], '1つずつ追加する方式では、追加ボタン（add_button）と追加済みタグの表示（added_items）を両方書いてください');
    }
    if (p.coupon !== undefined && (p.coupon.radio !== undefined ? p.coupon.chosen !== undefined : p.coupon.pick === undefined || p.coupon.chosen === undefined)) {
      issue(['coupon'], 'coupon には、radio（押す場所が別なら pick も）か、pick と chosen の組のどちらか一方を書いてください');
    }
    if (p.image.modal !== undefined && p.fields.image?.required === true) {
      issue(['fields', 'image', 'required'], '画像をダイアログで添付する画面（image.modal）では、ファイル欄はダイアログを開くまで無いので fields.image.required を false にしてください');
    }
    if (p.success_signals.completion_only === true && p.success_signals.completion_url_match === undefined) {
      issue(['success_signals', 'completion_url_match'], '完了画面だけで確かめる（completion_only）ときは、完了画面のURL（completion_url_match）が必要です');
    }
    const list = p.success_signals.list;
    if (list !== null && list.item.date === undefined && p.success_signals.detail === undefined) {
      issue(['success_signals', 'detail'], '一覧に日付の場所（list.item.date）が無いときは、詳細ページの指定（success_signals.detail）が必要です');
    }
    for (const [key, field] of Object.entries(p.fields)) {
      const isFixed = key.startsWith('fixed.');
      const isMapped = key.startsWith('mapped.');
      if (isFixed !== (field.fixed_option !== undefined)) {
        issue(['fields', key, 'fixed_option'], isFixed ? `${key} には固定の選択肢（fixed_option）が必要です` : 'fixed_option は fixed. で始まる欄にだけ書けます');
      }
      if (isMapped !== (field.map !== undefined)) {
        issue(['fields', key, 'map'], isMapped ? `${key} には解析結果との対応（map）が必要です` : 'map は mapped. で始まる欄にだけ書けます');
      }
      const isTreatment = key.startsWith('treatment.');
      if (isTreatment !== (field.confirmed_by !== undefined)) {
        issue(['fields', key, 'confirmed_by'], isTreatment ? `${key} には確認済みにするカテゴリー（confirmed_by）が必要です` : 'confirmed_by は treatment. で始まる欄にだけ書けます');
      }
      if (isTreatment && field.kind !== 'checkbox') issue(['fields', key, 'kind'], `${key} はチェックボックス（checkbox）だけです`);
      // Fields the content script sets to "none" (adapter want(); model_info.* when the photo does not decide): without that option it could only stop mid-page.
      const needsNone = key === 'feature' || key.startsWith('model_info.') || (key === 'coupon' && field.kind !== 'checkbox' && field.kind !== 'checkbox_group');
      if (needsNone && field.options?.none === undefined) issue(['fields', key, 'options', 'none'], `${key} には「選択しない」にあたる選択肢（options.none）が必要です`);
      if (field.map === undefined) continue;
      const values = MAPPABLE_SOURCE_VALUES[field.map.source];
      for (const option of Object.keys(field.map.options)) {
        if (option === 'unknown' || !values.includes(option)) {
          issue(['fields', key, 'map', 'options', option], `${field.map.source} の値に「${option}」はありません（unknown 以外の値: ${values.filter((v) => v !== 'unknown').join(', ')}）`);
        }
      }
    }
    if (p.poster?.mode === 'staff_field' && p.fields.staff === undefined) issue(['poster'], 'poster が staff_field のときはスタッフの欄（fields.staff）が必要です');
  });
export type PageProfile = z.infer<typeof PageProfileSchema>;
