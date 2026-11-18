import { type Browser, type BrowserContext, chromium } from 'playwright';
import type { RunConfigInfo } from '../report/schema.js';

export interface ConfigRequest {
  width: number;
  height: number;
  /** Browser zoom factor (1 = 100%). */
  zoom: number;
  colorScheme: 'light' | 'dark';
}

export const ZOOM_EMULATION =
  'Browser zoom Z is emulated by giving the page a CSS layout viewport of (window / Z) and devicePixelRatio Z, which is how ' +
  'Chromium page zoom affects layout and media queries. Browser-UI zoom code paths themselves are not exercised.';

export function configKey(c: ConfigRequest): string {
  return `${c.width}x${c.height}@${Math.round(c.zoom * 100)}${c.colorScheme === 'dark' ? '-dark' : ''}`;
}

export function cssViewport(c: ConfigRequest): { width: number; height: number } {
  return { width: Math.max(1, Math.round(c.width / c.zoom)), height: Math.max(1, Math.round(c.height / c.zoom)) };
}

/**
 * Lazily launches one headless Chromium and hands out isolated contexts.
 * Prefers Playwright's bundled Chromium; falls back to an installed Chrome
 * channel when the bundled browser is missing. QA_MCP_BROWSER_CHANNEL forces a channel.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private launchedWith = 'chromium';

  /** `headless: false` is used for operator-assisted (manual) logins. */
  constructor(private readonly launchOpts: { headless?: boolean } = {}) {}

  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    const channel = process.env.QA_MCP_BROWSER_CHANNEL;
    const headless = this.launchOpts.headless ?? process.env.QA_MCP_HEADED !== '1';
    if (channel) {
      this.browser = await chromium.launch({ channel, headless });
      this.launchedWith = channel;
      return this.browser;
    }
    try {
      this.browser = await chromium.launch({ headless });
      this.launchedWith = 'chromium';
    } catch (err) {
      const msg = (err as Error).message;
      if (!/Executable doesn't exist|executable/i.test(msg)) throw err;
      this.browser = await chromium.launch({ channel: 'chrome', headless });
      this.launchedWith = 'chrome';
    }
    return this.browser;
  }

  async newContext(c: ConfigRequest, extra: { storageState?: string; acceptDownloads?: boolean } = {}): Promise<{ context: BrowserContext; info: RunConfigInfo }> {
    const browser = await this.get();
    const css = cssViewport(c);
    const context = await browser.newContext({
      viewport: css,
      deviceScaleFactor: c.zoom,
      colorScheme: c.colorScheme,
      reducedMotion: 'reduce',
      ignoreHTTPSErrors: false,
      acceptDownloads: extra.acceptDownloads ?? true,
      ...(extra.storageState ? { storageState: extra.storageState } : {}),
    });
    const ua = await (async () => {
      const p = await context.newPage();
      const v = await p.evaluate(() => navigator.userAgent);
      await p.close();
      return v;
    })();
    const info: RunConfigInfo = {
      key: configKey(c),
      label: `${c.width}×${c.height} @ ${Math.round(c.zoom * 100)}%${c.colorScheme === 'dark' ? ' dark' : ''}`,
      viewport: { width: c.width, height: c.height },
      zoom: c.zoom,
      cssViewport: css,
      deviceScaleFactor: c.zoom,
      colorScheme: c.colorScheme,
      browser: this.launchedWith,
      browserVersion: browser.version(),
      userAgent: ua,
      zoomEmulation: ZOOM_EMULATION,
    };
    return { context, info };
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => undefined);
  }
}
