import { analysisCategories } from '../../ai/analyzer.js';
import { SKELETAL_DIAGNOSIS, confirmedByHint, photoTreatmentWords, restrictedTerms } from '../../ai/context.js';
import { primaryFieldOf, primaryTextOf, type Draft } from '../../ai/draft-schemas.js';
import { HAIR_CONSULTING, findSalonFacts, findUnverifiedTreatments } from '../../ai/word-rules.js';
import { looseKey, scanTerms } from '../scan.js';
import { hintedCategory } from './category-menus.js';
import { fieldJa, quoted, violation, type DraftField, type ValidationContext, type Violation } from '../types.js';

// Spec 10.1 step 6: forbidden and exaggerated wording, unverified treatments, and salon facts the config does not state
// (spec 9.1, 9.3, 9.4, 9.9). Words are matched on NFKC + lower case, as parts of the text (spec 5.5), minus the
// configured exceptions (必ずしも).

/** Staff titles, nominations and experience: salon facts unless salon.json states them. */
const STAFF = /店長|オーナー|代表(?!的)|トップスタイリスト|ディレクター|指名|在籍|経験\d+年|歴\d+年|\d+年目/gu;
/** A specific age is a statement about a person (spec 9.2: ages are 10代〜50代 target suggestions only). */
const AGE = /\d+(?:歳|才)/gu;
/** The model / customer said to be of an age, face shape or skeleton type (spec 6.2, 9.4). */
const PERSON =
  /(?:モデル|お客様|お客さま|こちらの方|この方)(?:さん|様|さま)?(?:は|が|の)[^。！？!?\n]{0,12}?(?:\d+代|\d+(?:歳|才)|丸顔|面長|卵型|たまご型|ベース型|逆三角形|骨格ストレート|骨格ウェーブ|骨格ナチュラル)/gu;

function fieldsOf(draft: Draft): DraftField[] {
  const fields: DraftField[] = [{ field: 'title', text: draft.title }];
  if (draft.post_type === 'style') fields.push({ field: 'menu_text', text: draft.menu_text });
  fields.push({ field: primaryFieldOf(draft.post_type), text: primaryTextOf(draft) });
  for (const t of draft.hashtags) fields.push({ field: 'hashtags', text: t });
  return fields;
}

function byField(fields: readonly DraftField[], find: (f: DraftField) => string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of fields) {
    const found = find(f);
    if (found.length > 0) out.set(f.field, [...new Set([...(out.get(f.field) ?? []), ...found])]);
  }
  return out;
}

const dedupeByKey = (words: readonly string[]): string[] => {
  const seen = new Set<string>();
  return words.filter((w) => {
    const k = looseKey(w);
    if (k === '' || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** looseKey of `text` with the verified phrases taken out (longest first), as findSalonFacts matches. */
function factKey(text: string, verified: readonly string[]): string {
  let k = looseKey(text);
  for (const fact of verified.map(looseKey).filter((f) => f !== '').sort((a, b) => b.length - a.length)) k = k.split(fact).join(' ');
  return k;
}

const matches = (text: string, re: RegExp, verified: readonly string[]): string[] => [...new Set([...factKey(text, verified).matchAll(re)].map((m) => m[0]))];

/** Every occurrence of a match that starts with a digit, widened to the whole number (5000円 and 1,500円, not 0円). */
function wholeNumbers(text: string, verified: readonly string[], found: readonly string[]): string[] {
  const k = factKey(text, verified);
  return [
    ...new Set(
      found.flatMap((token) => {
        if (!/^\d/u.test(token)) return [token];
        const out: string[] = [];
        for (let at = k.indexOf(token); at !== -1; at = k.indexOf(token, at + 1)) {
          let start = at;
          while (start > 0 && /[\d,.]/u.test(k[start - 1] ?? '')) start--;
          while (start < at && /[,.]/u.test(k[start] ?? '')) start++;
          out.push(k.slice(start, at + token.length));
        }
        return out.length > 0 ? out : [token];
      }),
    ),
  ];
}

/** Addresses (Plan 2 global constraints): postal marks, 住所 and block numbers. Station and walking times are SALON_FACT_PATTERNS'. */
const ADDRESS = /〒|住所|所在地|\d+丁目|\d+番地|\d+番\d+号/gu;
/**
 * Clock times that read as hours (matched on looseKey, so full-width digits and colons count): a range (10:00〜20:00),
 * or a time next to an hours word (20:00まで, 最終受付19:00, OPEN 10:00). A lone time (朝5:30でも) is left to the AI
 * check. Kept out of the shared SALON_FACT_PATTERNS, which also filter trend words.
 */
const TIME = String.raw`(?<!\d)\d{1,2}:\d{2}(?!\d)`;
const HOURS_WORD = 'まで|から|受付|営業|開店|閉店|最終|open|close|オープン|クローズ';
const CLOCK_TIME = new RegExp(`${TIME}[~〜\\-‐－ー–—]${TIME}|(?<=(?:${HOURS_WORD})[:は]?)${TIME}|${TIME}(?=${HOURS_WORD})`, 'gu');

/**
 * Group 6 (all hard): ng_word, guarantee_wording, restricted_term (骨格診断 without a formal diagnosis),
 * service_not_offered (ヘアコンサルティング when the salon does not offer it), unverified_treatment, salon_fact,
 * staff_claim, person_statement.
 */
export function checkClaims(draft: Draft, ctx: ValidationContext): Violation[] {
  const out: Violation[] = [];
  const { snapshot, generation } = ctx;
  const fields = fieldsOf(draft);
  const covers = snapshot.keywords.ng_word_exceptions.map((e) => e.context_pattern);
  const skeletal = dedupeByKey([SKELETAL_DIAGNOSIS, ...restrictedTerms(snapshot, 'formal_skeletal_diagnosis')]);
  const neverTerms = restrictedTerms(snapshot, 'never');
  // forbidden_words also carries the words reported by their own rule below (guarantees, 骨格診断, ヘアコンサルティング).
  const ownRule = new Set([...skeletal, ...neverTerms, HAIR_CONSULTING].map(looseKey));
  const configNg = new Set(snapshot.keywords.ng_words.map(looseKey));
  const ng = dedupeByKey([...snapshot.keywords.ng_words, ...generation.forbidden_words.filter((w) => !ownRule.has(looseKey(w)) || configNg.has(looseKey(w)))]);
  const ngKeys = new Set(ng.map(looseKey));
  const never = dedupeByKey(neverTerms).filter((t) => !ngKeys.has(looseKey(t)));

  const push = (found: Map<string, string[]>, rule: string, reason: (field: string, words: string[]) => string): void => {
    for (const [field, words] of found) out.push(violation(field, rule, 'hard', reason(field, words), { offending_text: words.join(' ') }));
  };

  push(byField(fields, (f) => scanTerms(f.text, ng, { covers })), 'ng_word', (field, w) => `${fieldJa(field)}に使えない語（NG語）があります: ${quoted(w)}。`);
  push(
    byField(fields, (f) => scanTerms(f.text, never, { covers })),
    'guarantee_wording',
    (field, w) => `${fieldJa(field)}に、断定や効果の保証になる言葉があります: ${quoted(w)}。髪型による見え方や提案として書いてください（例: 顔周りの長さを調整してバランスよく見せる）。`,
  );
  const skeletalAllowed = snapshot.salon.service_claims.formal_skeletal_diagnosis && generation.writing.skeletal_diagnosis_allowed;
  if (!skeletalAllowed) {
    push(
      byField(fields, (f) => scanTerms(f.text, skeletal)),
      'restricted_term',
      (field, w) => `${fieldJa(field)}に${quoted(w)}があります。店が正式な骨格診断を行っている設定（salon.json の service_claims.formal_skeletal_diagnosis）が無いため書けません。「骨格や顔型に合わせた似合わせ」のような提案にしてください。`,
    );
  }
  const consultingOffered = snapshot.salon.service_claims.hair_consulting && generation.salon.service_claims.hair_consulting;
  if (!consultingOffered) {
    push(
      byField(fields, (f) => scanTerms(f.text, [HAIR_CONSULTING])),
      'service_not_offered',
      (field) => `${fieldJa(field)}に「${HAIR_CONSULTING}」があります。店がヘアコンサルティングを扱わない設定（salon.json の service_claims.hair_consulting）のため書けません。`,
    );
  }

  // Treatments, re-derived here from the config (rulings P2-R5, P2-R12, P2-R15, P2-R15a): only the category the current
  // sidecar's category_hint confirms frees its words, plus ハイトーン seen with enough confidence; no menu name (registered,
  // sidecar or chosen) frees anything. The context's unverified list is added (fail-closed). Only the verbatim menu_text
  // field is exempt; matched like the generator (findUnverifiedTreatments: a verified phrase covers the words inside it).
  const drafted = generation.category.id === draft.category_id ? analysisCategories(snapshot, ctx.job.audience_category).find((c) => c.id === draft.category_id) : undefined;
  const confirmed = drafted !== undefined && confirmedByHint(drafted, hintedCategory(ctx)) ? drafted : null;
  const own = photoTreatmentWords(snapshot, confirmed, generation.analysis);
  const treatments = dedupeByKey([...own.unverified, ...generation.unverified_treatments]);
  push(
    byField(fields, (f) => (f.field === 'menu_text' ? [] : findUnverifiedTreatments(f.text, treatments, own.verified))),
    'unverified_treatment',
    (field, w) =>
      `${fieldJa(field)}に、この写真では確認できていない施術があります: ${quoted(w)}。施術は、その写真の sidecar.json の category_hint で確認されたものだけ書けます（メニュー名では確認になりません）。`,
  );

  // Salon facts the config does not state (the menu text is the menu rule's: group 4).
  const verifiedFacts = [...snapshot.salon.location_keywords, ...snapshot.salon.strengths];
  const reservationAllowed = generation.writing.reservation_guidance_allowed;
  push(
    byField(fields, (f) =>
      f.field === 'menu_text'
        ? []
        : [
            ...wholeNumbers(
              f.text,
              verifiedFacts,
              findSalonFacts(f.text, verifiedFacts).filter((m) => !(reservationAllowed && /予約/u.test(m))),
            ),
            ...matches(f.text, ADDRESS, verifiedFacts),
            ...matches(f.text, CLOCK_TIME, verifiedFacts),
          ],
    ),
    'salon_fact',
    (field, w) =>
      `${fieldJa(field)}に、設定で確認できない店舗の情報（料金・割引・限定・人気・ランキング・実績・予約・空席・営業時間・場所など）があります: ${quoted(w)}。設定に無い店舗の情報は書かないでください。`,
  );
  push(
    byField(fields, (f) => (f.field === 'menu_text' ? [] : matches(f.text, STAFF, verifiedFacts))),
    'staff_claim',
    (field, w) => `${fieldJa(field)}に、設定に無いスタッフの情報（役職・指名・経験年数など）があります: ${quoted(w)}。`,
  );
  push(
    byField(fields, (f) => (f.field === 'menu_text' ? [] : [...matches(f.text, AGE, []), ...matches(f.text, PERSON, [])])),
    'person_statement',
    (field, w) =>
      `${fieldJa(field)}に、写真の人物の年齢・顔型・骨格などを断定する書き方があります: ${quoted(w)}。年代や顔型は「〜の方にもおすすめ」のような一般的な提案として書いてください。`,
  );
  return out;
}
