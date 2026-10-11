import type { AppLogger } from '../logger.js';
import type { Clock } from '../shared/clock.js';
import { ERROR_MESSAGES_JA, type ErrorCode } from '../shared/errors.js';
import type { StopDto } from '../shared/protocol/status.js';
import { formatJst, jstDateKey, jstToUtc } from '../shared/time.js';
import type { AudienceCategory, PostType } from '../shared/types.js';
import type { ControlStore, Stop } from '../storage/control-store.js';
import { internalFailure } from '../storage/store-errors.js';

export type StopScope = 'salon' | 'type' | 'route';

/** Which page outcomes stop new posting, and how widely (plan §5.6). POST_RESULT_UNKNOWN only with a detail. */
export const STOP_SCOPE = {
  AUTH_REQUIRED: 'salon',
  LOGIN_FAILED: 'salon',
  MFA_REQUIRED: 'salon',
  CAPTCHA: 'salon',
  ACCOUNT_ERROR: 'salon',
  SALON_BOARD_PAGE_CHANGED: 'salon',
  WRONG_SALON: 'salon',
  POST_RESULT_UNKNOWN: 'salon',
  LIMIT_REACHED: 'type',
  POST_TARGET_MISMATCH: 'route',
  UPLOAD_UNSUPPORTED: 'route',
} as const satisfies Partial<Record<ErrorCode, StopScope>>;
export type StopCode = keyof typeof STOP_SCOPE;

/** Salon stops that also stop automatic reconcile (§5.5): it would only meet the same login/salon screen. */
export const RECONCILE_BLOCKING: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['AUTH_REQUIRED', 'LOGIN_FAILED', 'MFA_REQUIRED', 'CAPTCHA', 'ACCOUNT_ERROR', 'WRONG_SALON']);

const LOGIN_REMEDY = 'SALON BOARD へのログインが必要です。Chrome でログインしてから「再開」（npm.cmd run resume）を実行してください。ツールが自動でログインすることはありません。';

/** What the owner does about each stop (plan §11). */
export const STOP_REMEDY_JA: Record<StopCode, string> = {
  AUTH_REQUIRED: LOGIN_REMEDY,
  LOGIN_FAILED: LOGIN_REMEDY,
  MFA_REQUIRED: '追加認証（2段階認証）が必要です。Chrome で認証を済ませてから再開してください。',
  CAPTCHA: '画像認証（CAPTCHA）が表示されました。ツールは突破しません。Chrome で画面を確認してから再開してください。',
  ACCOUNT_ERROR: 'アカウントに関するお知らせが表示されました。SALON BOARD の画面を確認してから再開してください。',
  SALON_BOARD_PAGE_CHANGED: '投稿画面の形が変わった可能性があります。開発担当に画面の調査を依頼してください（画面設定の修正後に再開します）。',
  WRONG_SALON: '別の店舗の画面が開いていました。このサロンのアカウントでログインし直してから再開してください。',
  POST_RESULT_UNKNOWN: '登録できたか確認できない投稿があります。npm.cmd run reconcile で照合してから再開してください。',
  LIMIT_REACHED: '投稿数の上限に達したと画面に表示されました。残り件数を確認して npm.cmd run checks:record -- count … で記録してから再開してください。',
  POST_TARGET_MISMATCH: '投稿先の画面が設定と違いました（例: メンズの投稿先がレディースの画面）。投稿先URL設定を確認してから再開してください。',
  UPLOAD_UNSUPPORTED: '画像の添付が画面に受け付けられませんでした。開発担当に連絡してください（内部の仕組みを使った回避はしません）。',
};

const DETAIL_REMEDY_JA: Record<string, string> = {
  navigated_during_input: '入力の途中で画面が切り替わりました。登録された可能性があるため、自動では登録し直しません。照合の結果を確認してから再開してください。',
  unrecorded_send_suspected: '保存データより新しい送信記録があります。バックアップから戻した可能性があるため、SALON BOARD の画面で照合するまで新規送信を止めます。',
  reconcile_conflict: '「登録なし」と記録した投稿が、画面では登録されていました。同じ投稿が2回登録されていないか確認し、npm.cmd run resume -- --confirm-checked で再開してください。',
};

type Period = NonNullable<Stop['period']>;

/** 'YYYY-MM-DD HH:mm' (JST) when a period-bound stop clears by itself, or null. */
function clearsAtJst(periodKey: string | null): string | null {
  if (periodKey === null) return null;
  if (periodKey.length === 10) return formatJst(jstToUtc(periodKey, 24 * 60));
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01 00:00` : `${y}-${String(m + 1).padStart(2, '0')}-01 00:00`;
}

function remedyFor(code: StopCode, detail: string | null, periodKey: string | null): string {
  const clears = clearsAtJst(periodKey);
  if (code === 'LIMIT_REACHED' && clears !== null) return `投稿数の上限に達したと画面に表示されました。自動で解除: ${clears}。`;
  return (detail !== null ? DETAIL_REMEDY_JA[detail] : undefined) ?? STOP_REMEDY_JA[code];
}

/** The API / status view of a stop. */
export function stopDto(s: Stop): StopDto {
  return {
    scope: s.scope,
    post_type: s.post_type,
    audience_category: s.audience_category,
    code: s.code,
    message: s.message,
    remedy: s.remedy,
    job_id: s.job_id,
    raised_at_jst: formatJst(new Date(s.raised_at)),
    clears_at_jst: clearsAtJst(s.period_key),
  };
}

/**
 * The stops of new posting, kept in control.json (P1-R25). A stop is raised from screen evidence or a startup check and is
 * cleared by the operator (resume/preflight, Task 2c) or, for a period-bound LIMIT_REACHED, at the next period.
 */
export class StopRegistry {
  readonly #control: ControlStore;
  readonly #clock: Clock;
  readonly #logger: AppLogger;

  constructor(control: ControlStore, clock: Clock, logger: AppLogger) {
    this.#control = control;
    this.#clock = clock;
    this.#logger = logger;
  }

  /**
   * Raises the stop (its scope comes from STOP_SCOPE) and returns it; raising one that is already active changes nothing.
   * A type stop needs `post_type`, a route stop both; a daily/monthly `period` makes it clear by itself at the next period.
   */
  async raise(
    code: StopCode,
    target: { post_type?: PostType | null; audience_category?: AudienceCategory | null },
    o: { jobId?: string | null; routeConfigHash?: string | null; detail?: string | null; period?: Period | null } = {},
  ): Promise<Stop> {
    const scope: StopScope = STOP_SCOPE[code];
    const postType = scope === 'salon' ? null : (target.post_type ?? null);
    const audience = scope === 'route' ? (target.audience_category ?? null) : null;
    if ((scope !== 'salon' && postType === null) || (scope === 'route' && audience === null)) {
      throw internalFailure(this.#clock, `停止の範囲（${scope}）に必要な種別・対象が指定されていません: ${code}`, { code, scope });
    }
    const now = this.#clock.now();
    const detail = o.detail ?? null;
    const period = o.period ?? null;
    const periodKey = period === 'daily' ? jstDateKey(now) : period === 'monthly' ? jstDateKey(now).slice(0, 7) : null;
    const id = [scope, code, postType ?? '*', audience ?? '*', detail, period].filter((x) => x !== null).join(':');
    const stop: Stop = {
      id,
      scope,
      post_type: postType,
      audience_category: audience,
      code,
      detail,
      message: ERROR_MESSAGES_JA[code],
      remedy: remedyFor(code, detail, periodKey),
      job_id: o.jobId ?? null,
      raised_at: now.toISOString(),
      route_config_hash: o.routeConfigHash ?? null,
      period,
      period_key: periodKey,
    };
    let added = false;
    await this.#control.update((s) => {
      if (s.stops.some((x) => x.id === id)) return null;
      added = true;
      return { stops: [...s.stops, stop] };
    });
    if (!added) return this.active().find((x) => x.id === id) ?? stop;
    this.#logger.warn('STOP_RAISED', `新規の投稿を止めました（${ERROR_MESSAGES_JA[code]}）。${stop.remedy}`, {
      stop_id: id,
      error_code: code,
      scope,
      post_type: postType,
      audience_category: audience,
      detail,
      job_id: stop.job_id,
    });
    return stop;
  }

  active(): Stop[] {
    return this.#control.get().stops;
  }

  blocksSalon(): Stop | null {
    return this.active().find((s) => s.scope === 'salon') ?? null;
  }

  blocksReconcile(): Stop | null {
    return this.active().find((s) => s.scope === 'salon' && RECONCILE_BLOCKING.has(s.code)) ?? null;
  }

  blocksType(t: PostType): Stop | null {
    return this.active().find((s) => s.scope === 'type' && s.post_type === t) ?? null;
  }

  blocksRoute(t: PostType, a: AudienceCategory): Stop | null {
    return this.active().find((s) => s.scope === 'route' && s.post_type === t && s.audience_category === a) ?? null;
  }

  /** Removes the given stops (unknown ids are ignored); `why` is a fixed token for the log. */
  async clear(ids: readonly string[], why: string): Promise<void> {
    const removed: string[] = [];
    await this.#control.update((s) => {
      const keep = s.stops.filter((x) => !ids.includes(x.id));
      if (keep.length === s.stops.length) return null;
      removed.push(...s.stops.filter((x) => ids.includes(x.id)).map((x) => x.id));
      return { stops: keep };
    });
    if (removed.length > 0) this.#logger.info('STOP_CLEARED', `投稿の停止を解除しました（${removed.length}件）。`, { stop_ids: removed, reason: why });
  }

  /** Clears the daily/monthly stops whose period has passed (JST calendar) and returns them. */
  async clearExpiredPeriods(now: Date): Promise<Stop[]> {
    const today = jstDateKey(now);
    const expired = this.active().filter((s) => s.period_key !== null && s.period_key < (s.period_key.length === 10 ? today : today.slice(0, 7)));
    if (expired.length > 0) await this.clear(expired.map((s) => s.id), 'period_ended');
    return expired;
  }
}
