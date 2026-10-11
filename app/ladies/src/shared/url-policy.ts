/** Which SALON BOARD origins may be used (allowed_origins, route URLs, navigation). Pure. */
export interface UrlPolicy {
  /** null when the origin may be used, else a Japanese reason. */
  checkOrigin(origin: string): string | null;
}

/** Production: https domain names on the standard port only. Tests inject another policy through RuntimeOptions.api. */
export const PRODUCTION_URL_POLICY: UrlPolicy = {
  checkOrigin(origin) {
    const u = URL.parse(origin);
    if (u === null || u.origin !== origin) return '接続先は https://ドメイン名 の形（小文字、パスや末尾の / なし）で書いてください';
    if (u.protocol !== 'https:') return 'https の接続先だけ使えます';
    const host = u.hostname;
    if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost は接続先にできません';
    if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'IPアドレスは接続先にできません。ドメイン名を書いてください';
    if (u.port !== '') return `標準以外のポート（:${u.port}）は使えません`;
    return null;
  },
};
