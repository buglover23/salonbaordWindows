import { analysisCategories, resolveHint, type CategoryEntry } from '../../ai/analyzer.js';
import { confirmedByHint } from '../../ai/context.js';
import { MAX_MENU_ITEMS, composeMenuText, splitMenuText, type Draft } from '../../ai/draft-schemas.js';
import { looseKey } from '../../ai/word-rules.js';
import { AUDIENCE_JA } from '../../shared/labels.js';
import { graphemeSlice } from '../../shared/text.js';
import { violation, type ValidationContext, type Violation } from '../types.js';

// Spec 10.1 step 4: the category against the audience's categories and the job's chosen one (P2-R5: a category a photo
// cannot prove only with the sidecar's category_hint, P2-R15: never a menu name), style menus only from salon.verified_menus (P2-R9), and the fixed
// policy of spec 1.2 (no coupon, price or discount in the menu).

const MENU_PRICE = /[\d千万]円|[¥$]\d|\d(?:%|パーセント)|\doff|半額|割引|値引|クーポン|キャンペーン|特典|無料|限定|税込|税抜/u;

/**
 * Group 4: category_mismatch, category_not_for_audience, category_unconfirmed (all not fixable by a rewrite), and for
 * style posts menu_missing, unverified_menu, menu_too_many, menu_not_sidecar, menu_not_for_photo, menu_price (or
 * menu_price_config when only the config can fix it). All hard.
 */
/** The category the current sidecar's category_hint names for the job's audience (ruling P2-R15), if any. */
export function hintedCategory(ctx: ValidationContext): CategoryEntry | undefined {
  const hint = ctx.generation.sidecar?.category_hint ?? null;
  return hint === null ? undefined : resolveHint(hint, analysisCategories(ctx.snapshot, ctx.job.audience_category));
}

export function checkCategoryAndMenus(draft: Draft, ctx: ValidationContext): Violation[] {
  const out: Violation[] = [];
  const { generation, job, snapshot } = ctx;
  const categories = analysisCategories(snapshot, job.audience_category);
  const category = categories.find((c) => c.id === draft.category_id);
  const shownId = graphemeSlice(draft.category_id, 64);
  if (draft.category_id !== generation.category.id) {
    out.push(
      violation('category_id', 'category_mismatch', 'hard', `下書きのカテゴリー（${shownId}）が、画像解析で決めたカテゴリー（${generation.category.id}）と違います。`, {
        actual: shownId,
        limit: generation.category.id,
      }),
    );
  }
  if (category === undefined) {
    out.push(
      violation('category_id', 'category_not_for_audience', 'hard', `カテゴリー（${shownId}）は、${AUDIENCE_JA[job.audience_category]}のカテゴリー（categories.json）にありません。`, {
        actual: shownId,
      }),
    );
  } else if (!confirmedByHint(category, hintedCategory(ctx))) {
    out.push(
      violation(
        'category_id',
        'category_unconfirmed',
        'hard',
        `カテゴリー「${category.label}」は写真だけでは裏付けられない施術のカテゴリーで、sidecar.json の category_hint で確認されていません（メニュー名では確認になりません）。`,
        { actual: category.id },
      ),
    );
  }

  if (draft.post_type !== 'style') return out;
  const verified = snapshot.salon.verified_menus;
  if (draft.menu_text === '') {
    out.push(violation('menu_text', 'menu_missing', 'hard', 'メニューがありません。確認済みメニュー（salon.json の verified_menus）から選んでください。'));
    return out;
  }
  const items = splitMenuText(draft.menu_text, verified);
  if (items === null) {
    out.push(
      violation('menu_text', 'unverified_menu', 'hard', 'メニューが確認済みメニュー（salon.json の verified_menus）の組み合わせになっていません。登録されたメニュー名をそのまま使ってください。', {
        offending_text: draft.menu_text,
      }),
    );
  } else {
    if (items.length > MAX_MENU_ITEMS) {
      out.push(violation('menu_text', 'menu_too_many', 'hard', `メニューは${MAX_MENU_ITEMS}件までにしてください（${items.length}件）。`, { actual: items.length, limit: MAX_MENU_ITEMS }));
    }
    const menus = generation.menus;
    if (menus?.mode === 'sidecar' && draft.menu_text !== composeMenuText(menus.fixed)) {
      out.push(
        violation('menu_text', 'menu_not_sidecar', 'hard', `この写真のメニューは sidecar.json で「${composeMenuText(menus.fixed)}」と指定されています。そのとおりにしてください。`, {
          offending_text: draft.menu_text,
        }),
      );
    } else if (menus?.mode === 'choose') {
      const notForPhoto = items.filter((i) => !menus.allowed.includes(i));
      if (notForPhoto.length > 0) {
        out.push(
          violation('menu_text', 'menu_not_for_photo', 'hard', `この写真で確認できない施術を含むメニューは使えません: ${notForPhoto.map((m) => `「${m}」`).join('')}`, {
            offending_text: notForPhoto.join('／'),
          }),
        );
      }
    }
  }
  const price = priceIn(draft.menu_text);
  if (price !== null) {
    // No rewrite helps when the config itself puts the price there: the sidecar fixes the menu, or every menu the photo
    // may use carries one. Then the owner has to fix salon.json (not regenerable, so no AI calls are wasted).
    const menus = generation.menus;
    const fromConfig =
      (menus?.mode === 'sidecar' && priceIn(composeMenuText(menus.fixed)) !== null) || (menus?.mode === 'choose' && menus.allowed.every((m) => priceIn(m) !== null));
    out.push(
      fromConfig
        ? violation(
            'menu_text',
            'menu_price_config',
            'hard',
            `この写真で使えるメニューがすべて料金・割引・クーポンなどの表記（${price[0]}）を含むため、スタイル投稿のメニューを作れません（固定方針: 料金やクーポンは載せません）。salon.json の verified_menus に料金を含まないメニュー名を登録するか、sidecar.json の verified_menu_ids を直してください。`,
            { offending_text: price[0] },
          )
        : violation(
            'menu_text',
            'menu_price',
            'hard',
            `メニューに料金・割引・クーポンなどの表記（${price[0]}）があります。スタイル投稿では料金やクーポンを載せません（固定方針）。料金を含まないメニューを選ぶか、salon.json の verified_menus には料金を含まないメニュー名を登録してください。`,
            { offending_text: price[0] },
          ),
    );
  }
  return out;
}

const priceIn = (text: string): RegExpExecArray | null => MENU_PRICE.exec(looseKey(text));
