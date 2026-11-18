import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { DESTRUCTIVE } from '../../src/browser/actions.js';
import { annotate, diffCount } from '../../src/evidence/png.js';
import { checkUrl, policyFromEnv } from '../../src/safety/policy.js';

function solid(w: number, h: number, rgb: [number, number, number]): PNG {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    p.data[i * 4] = rgb[0];
    p.data[i * 4 + 1] = rgb[1];
    p.data[i * 4 + 2] = rgb[2];
    p.data[i * 4 + 3] = 255;
  }
  return p;
}

describe('png helpers', () => {
  it('counts changed pixels above the channel threshold only', () => {
    const a = solid(10, 10, [255, 255, 255]);
    const b = solid(10, 10, [255, 255, 255]);
    expect(diffCount(a, b, 24)).toBe(0);
    b.data[0] = 250; // below threshold
    b.data[4] = 0; // above threshold
    expect(diffCount(a, b, 24)).toBe(1);
  });

  it('draws role-coloured outlines without touching the interior', () => {
    const out = annotate(solid(20, 20, [255, 255, 255]), [{ rect: { x: 2, y: 2, w: 10, h: 10 }, role: 'subject' }]);
    const px = (x: number, y: number) => Array.from(out.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 3));
    expect(px(2, 2)).toEqual([230, 25, 75]);
    expect(px(7, 7)).toEqual([255, 255, 255]);
  });
});

describe('target policy', () => {
  const policy = policyFromEnv({});

  it('allows loopback and file targets by default', () => {
    expect(checkUrl('http://127.0.0.1:4410/x.html', policy).ok).toBe(true);
    expect(checkUrl('http://localhost:3000/', policy).ok).toBe(true);
    expect(checkUrl('http://app.localhost/', policy).ok).toBe(true);
    expect(checkUrl('file:///C:/tmp/page.html', policy).ok).toBe(true);
  });

  it('refuses non-authorised origins and unsupported protocols', () => {
    expect(checkUrl('https://example.com/', policy).ok).toBe(false);
    expect(checkUrl('javascript:alert(1)', policy).ok).toBe(false);
    expect(checkUrl('not a url', policy).ok).toBe(false);
  });

  it('honours explicit origins and host wildcards', () => {
    const p = policyFromEnv({ QA_MCP_ALLOWED_ORIGINS: 'https://staging.example.com, https://*.preview.example.com' });
    expect(checkUrl('https://staging.example.com/a', p).ok).toBe(true);
    expect(checkUrl('https://pr-12.preview.example.com/', p).ok).toBe(true);
    expect(checkUrl('https://example.com/', p).ok).toBe(false);
    expect(checkUrl('http://staging.example.com/', p).ok).toBe(false);
  });

  it('recognises destructive-looking control labels', () => {
    for (const label of ['Delete account', 'Pay now', 'Place order', 'Unsubscribe']) expect(DESTRUCTIVE.test(label)).toBe(true);
    for (const label of ['Sort by', 'Open menu', 'Payment history filters']) expect(DESTRUCTIVE.test(label)).toBe(false);
  });
});
