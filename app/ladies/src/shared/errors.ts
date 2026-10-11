import { z } from 'zod';
import type { Clock } from './clock.js';
import { SUBMISSION_STATES, type SubmissionState } from './types.js';
import { isoUtc } from './zod-helpers.js';

// Spec section 15.1 table order (split rows expanded in place), then the two internal codes.
export const ERROR_CODES = [
  'CONFIG_INVALID',
  'CONFIG_INCOMPLETE',
  'IMAGE_CATEGORY_REQUIRED',
  'POST_TARGET_UNCONFIGURED',
  'POST_TARGET_UNVERIFIED',
  'POST_TARGET_MISMATCH',
  'INSTRUCTION_INVALID',
  'INSTRUCTION_CONFLICT',
  'TEMPLATE_MISSING',
  'TEMPLATE_PARSE_ERROR',
  'TREND_FETCH_FAILED',
  'IMAGE_INVALID',
  'IMAGE_NOT_FOUND',
  'IMAGE_ANALYSIS_UNCERTAIN',
  'AI_TIMEOUT',
  'AI_RATE_LIMIT',
  'AI_UNAVAILABLE',
  'AI_AUTH_ERROR',
  'AI_BUDGET_EXCEEDED',
  'AI_OUTPUT_INVALID',
  'VALIDATION_FAILED',
  'DUPLICATE_CONTENT',
  'DUPLICATE_IMAGE',
  'ALREADY_POSTED',
  'EXTENSION_DISCONNECTED',
  'NETWORK_ERROR',
  'PAGE_TIMEOUT',
  'UPLOAD_TIMEOUT',
  'UPLOAD_FAILED',
  'UPLOAD_UNSUPPORTED',
  'SUBMIT_FAILED',
  'POST_RESULT_UNKNOWN',
  'VERIFY_TIMEOUT',
  'AUTH_REQUIRED',
  'LOGIN_FAILED',
  'MFA_REQUIRED',
  'EXTERNAL_REQUIREMENT_UNVERIFIED',
  'AUTOMATION_NOT_PERMITTED',
  'LIMIT_REACHED',
  'POST_CAPACITY_UNKNOWN',
  'CAPTCHA',
  'ACCOUNT_ERROR',
  'SALON_BOARD_PAGE_CHANGED',
  'WRONG_SALON',
  'STALE_COMMAND',
  'FILE_IO_ERROR',
  'DISK_FULL',
  'STATE_CORRUPT',
  'LOCK_CONFLICT',
  'RESOURCE_DISK_LOW',
  'RESOURCE_MEMORY_HIGH',
  'CLEANUP_FAILED',
  'PORT_IN_USE',
  'LAUNCH_PREREQUISITE_MISSING',
  'RETRY_EXHAUSTED',
  'REVISION_CONFLICT',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Lives here (not in job-schema.ts) so errors.ts and job-schema.ts do not import each other.
export const AppErrorSchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  stage: z.string(),
  message: z.string(),
  occurred_at: isoUtc,
  retryable: z.boolean(),
  submission_state: z.enum(SUBMISSION_STATES),
  details_redacted: z.record(z.string(), z.unknown()),
});
export type AppError = z.infer<typeof AppErrorSchema>;

export const ERROR_MESSAGES_JA: Record<ErrorCode, string> = {
  CONFIG_INVALID: '設定ファイルに誤りがあるため、修正するまで投稿しません。',
  CONFIG_INCOMPLETE: '設定が未完了のため、必要な項目を記入するまで投稿しません。',
  IMAGE_CATEGORY_REQUIRED: '画像の種別と対象（男性・女性）が分からないため、4つの専用フォルダのいずれかへ置き直してください。',
  POST_TARGET_UNCONFIGURED: '投稿先のURLが未設定のため、この種別・対象の投稿を保留しています。',
  POST_TARGET_UNVERIFIED: '投稿先の画面が未確認のため、この種別・対象の投稿を保留しています。',
  POST_TARGET_MISMATCH: '投稿先の画面が設定と一致しないため、入力と登録を止めました。',
  INSTRUCTION_INVALID: '指示書の内容に誤りがあるため、変更を反映せず直前の正常な設定で続けます。',
  INSTRUCTION_CONFLICT: '指示書の内容が矛盾しているため、変更を反映せず直前の正常な設定で続けます。',
  TEMPLATE_MISSING: 'テンプレートが見つかりません。有効なキャッシュが無い場合は文章の生成を保留します（テンプレートの原本か対応表を修正してください）。',
  TEMPLATE_PARSE_ERROR: 'テンプレートを読み取れません。有効なキャッシュが無い場合は文章の生成を保留します（テンプレートの原本か対応表を修正してください）。',
  TREND_FETCH_FAILED: 'トレンド情報を取得できなかったため、保存済みの情報で続けます。',
  IMAGE_INVALID: 'この画像は読み取れないため、JPEGまたはPNGで保存し直して再投入してください。',
  IMAGE_NOT_FOUND: '画像ファイルが見つからないため、画像を戻してから再開してください。',
  IMAGE_ANALYSIS_UNCERTAIN: '画像の内容を確実に判定できないため、根拠を補うか画像を差し替えてください。',
  AI_TIMEOUT: 'AIの応答が時間内に返らなかったため、設定した上限回数まで再試行し、上限に達したら失敗として保存します。',
  AI_RATE_LIMIT: 'AIの利用回数の制限にかかったため、少し待ってから設定した上限回数まで再試行し、上限に達したら失敗として保存します。',
  AI_UNAVAILABLE: 'AIサービスに接続できないため、少し待ってから設定した上限回数まで再試行し、上限に達したら失敗として保存します。',
  AI_AUTH_ERROR: 'AIのAPIキーが正しくないため、キーを修正してから再開してください。',
  AI_BUDGET_EXCEEDED: 'AIの利用予算の上限に達したため、予算を修正するか日次リセットを待ってください。',
  AI_OUTPUT_INVALID: 'AIの出力が規定の形式ではないため、エラー内容を付けて再生成します。',
  VALIDATION_FAILED: '生成した文章が検査に通らず再生成の上限に達したため、失敗として保存しました。',
  DUPLICATE_CONTENT: '生成した文章が過去の投稿と重複し再生成の上限に達したため、失敗として保存しました。',
  DUPLICATE_IMAGE: '同じ画像がすでに登録されているため、新しい投稿は作りません。',
  ALREADY_POSTED: 'この投稿はすでに登録済みのため、新しく登録しません。',
  EXTENSION_DISCONNECTED: 'ブラウザ拡張との接続が切れたため、送信前なら待機し、送信後なら登録結果を照合します。',
  NETWORK_ERROR: '通信エラーが発生したため、登録の有無を確かめたうえで対応します。',
  PAGE_TIMEOUT: '画面の応答が時間内に返らなかったため、登録の有無を確かめたうえで対応します。',
  UPLOAD_TIMEOUT: '画像のアップロードが時間内に終わらなかったため、登録前であれば再試行します。',
  UPLOAD_FAILED: '画像のアップロードに失敗したため、登録前であれば再試行します。',
  UPLOAD_UNSUPPORTED: '正規画面で画像を送る方式に対応できないため、実装方式を修正するまで停止します。',
  SUBMIT_FAILED: '画面が登録を受け付けなかったため、未登録が確定している場合のみ再試行します。',
  POST_RESULT_UNKNOWN: '登録できたか確認できないため、自動では登録し直さず画面での照合を待ちます。',
  VERIFY_TIMEOUT: '登録結果の確認が時間内に終わらなかったため、自動では登録し直さず画面での照合を待ちます。',
  AUTH_REQUIRED: 'SALON BOARDへのログインが必要なため、手動でログインするまで新規投稿を止めます。',
  LOGIN_FAILED: 'SALON BOARDへのログインに失敗したため、手動でログインするまで新規投稿を止めます。',
  MFA_REQUIRED: '追加認証が必要なため、手動で認証を済ませてから再開してください。',
  EXTERNAL_REQUIREMENT_UNVERIFIED: '本番送信の前提条件を確認できていないため、本番送信は開始しません。',
  AUTOMATION_NOT_PERMITTED: '自動操作が許可されていないため、本番送信は開始しません。',
  LIMIT_REACHED: '投稿数の上限に達したため、この種別の送信を止めています（残枠の確認か設定の調整が必要です）。',
  POST_CAPACITY_UNKNOWN: '投稿の残枠を確認できないため、この種別の送信を止めています。',
  CAPTCHA: '画像認証（CAPTCHA）が表示されたため、迂回せずに新規投稿を止めました。',
  ACCOUNT_ERROR: 'アカウントに問題が出ているため、迂回せずに新規投稿を止めました。',
  SALON_BOARD_PAGE_CHANGED: 'SALON BOARDの画面が想定と異なるため、画面や設定を修正するまで新規投稿を止めます。',
  WRONG_SALON: '想定と異なる店舗の画面だったため、新規投稿を止めました。',
  STALE_COMMAND: '現在の送信試行と一致しない操作だったため、拒否しました。',
  FILE_IO_ERROR: 'ファイルの読み書きに失敗したため、書込を伴う新しい処理を止めます。',
  DISK_FULL: 'ディスクの空き容量が足りないため、書込を伴う新しい処理を止めます。',
  STATE_CORRUPT: '保存データが壊れているため、復旧するまで処理を進めません。',
  LOCK_CONFLICT: '別のプロセスが動作中の可能性があるため、確認できるまで開始しません。',
  RESOURCE_DISK_LOW: 'ディスクの空きが少ないため、新しい処理を止めて回復を待ちます。',
  RESOURCE_MEMORY_HIGH: 'メモリの使用量が多いため、新しい処理を止めて回復を待ちます。',
  CLEANUP_FAILED: '不要ファイルの削除に失敗したため、後で上限付きで再試行します。',
  PORT_IN_USE: '使用するポートがすでに使われているため、起動を止めました。',
  LAUNCH_PREREQUISITE_MISSING: '起動に必要な準備が足りないため、起動を止めました。',
  RETRY_EXHAUSTED: '再試行の上限に達したため、失敗のまま保持しており、手動で再開できます。',
  REVISION_CONFLICT: '保存データが別の更新と衝突したため、最新の状態を読み直してやり直してください。',
  INTERNAL_ERROR: '想定外のエラーが発生したため、処理を止めました（詳細はログを確認してください）。',
};

// Defaults only: callers override per call because retryability depends on whether a submission may have happened (spec 15.1).
const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'AI_TIMEOUT',
  'AI_RATE_LIMIT',
  'AI_UNAVAILABLE',
  'AI_OUTPUT_INVALID',
  'NETWORK_ERROR',
  'PAGE_TIMEOUT',
  'UPLOAD_TIMEOUT',
  'UPLOAD_FAILED',
  'TREND_FETCH_FAILED',
]);

/**
 * Builds an AppError stamped with `clock`.
 * - `opts.details` is stored as `details_redacted` as is, so the caller must pass it already redacted:
 *   no secrets (keys, tokens, cookies, passwords), no full post text (use hashes and lengths), no image bytes.
 * - An empty or whitespace-only `opts.message` falls back to the default Japanese message for `code`.
 */
export function appError(
  code: ErrorCode,
  stage: string,
  clock: Clock,
  opts?: {
    message?: string;
    retryable?: boolean;
    submission_state?: SubmissionState;
    details?: Record<string, unknown>;
  },
): AppError {
  const message = opts?.message;
  return {
    code,
    stage,
    message: message !== undefined && message.trim() !== '' ? message : ERROR_MESSAGES_JA[code],
    occurred_at: clock.now().toISOString(),
    retryable: opts?.retryable ?? RETRYABLE_BY_DEFAULT.has(code),
    submission_state: opts?.submission_state ?? 'not_started',
    details_redacted: opts?.details ?? {},
  };
}

export class AppFailure extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = 'AppFailure';
    this.error = error;
  }
}

/** The error code to report for anything caught: an AppFailure's own code, otherwise INTERNAL_ERROR. */
export function errorCodeOf(err: unknown): ErrorCode {
  return err instanceof AppFailure ? err.error.code : 'INTERNAL_ERROR';
}

/**
 * One line describing anything caught, for log messages and the console only (never stored in job data): an AppFailure's
 * own message, otherwise `<name>: <message>`. Never throws.
 */
export function errorText(err: unknown): string {
  if (err instanceof AppFailure) return err.error.message;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return typeof err;
  }
}
