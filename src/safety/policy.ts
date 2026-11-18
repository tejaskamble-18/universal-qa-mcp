/**
 * Target policy: which URLs this server may open.
 *
 * By default only loopback hosts (localhost, 127.0.0.0/8, ::1, *.localhost)
 * and file: URLs are allowed. Other origins must be authorised explicitly via
 * QA_MCP_ALLOWED_ORIGINS (comma separated): exact origins
 * ("https://staging.example.com"), host wildcards ("https://*.example.com"),
 * or "*" to allow any http(s) origin.
 */
export interface TargetPolicy {
  allowed: string[];
  allowAny: boolean;
  allowFile: boolean;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): TargetPolicy {
  const raw = (env.QA_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    allowed: raw.filter((s) => s !== '*'),
    allowAny: raw.includes('*'),
    allowFile: env.QA_MCP_ALLOW_FILE !== '0',
  };
}

export function isLoopback(url: URL): boolean {
  const h = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function originMatches(url: URL, pattern: string): boolean {
  let p: URL;
  try {
    p = new URL(pattern.replace('://*.', '://wildcard-placeholder.'));
  } catch {
    return false;
  }
  if (p.protocol !== url.protocol) return false;
  if (p.port !== url.port) return false;
  if (pattern.includes('://*.')) {
    const suffix = p.hostname.replace(/^wildcard-placeholder\./, '');
    return url.hostname === suffix || url.hostname.endsWith(`.${suffix}`);
  }
  return p.hostname === url.hostname;
}

export type PolicyResult = { ok: true; url: URL; loopback: boolean } | { ok: false; reason: string };

export function checkUrl(raw: string, policy: TargetPolicy): PolicyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `Not a valid absolute URL: ${raw}` };
  }
  if (url.protocol === 'file:') {
    return policy.allowFile ? { ok: true, url, loopback: true } : { ok: false, reason: 'file: URLs are disabled (QA_MCP_ALLOW_FILE=0).' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol ${url.protocol}` };
  }
  if (isLoopback(url)) return { ok: true, url, loopback: true };
  if (policy.allowAny || policy.allowed.some((p) => originMatches(url, p))) return { ok: true, url, loopback: false };
  return {
    ok: false,
    reason:
      `Origin ${url.origin} is not authorised. Only loopback/file targets are allowed by default. ` +
      'To audit an application you are authorised to test, add its origin to QA_MCP_ALLOWED_ORIGINS in the MCP server config ' +
      '(e.g. "https://staging.example.com").',
  };
}
