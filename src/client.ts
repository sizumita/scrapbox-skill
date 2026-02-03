import { chromium, type Browser, type BrowserContext } from 'playwright';

export type ClientOptions = {
  project: string;
  host?: string;
  sid?: string; // connect.sid
  headless?: boolean;
};

export type ListOptions = {
  limit?: number;
  skip?: number;
};

export class ScrapboxClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private host: string;
  private project: string;
  private sid?: string;
  private headless: boolean;

  private constructor(opts: ClientOptions) {
    this.host = normalizeHost(opts.host ?? 'https://scrapbox.io');
    this.project = opts.project;
    this.sid = opts.sid;
    this.headless = opts.headless ?? true;
  }

  static async create(opts: ClientOptions) {
    const client = new ScrapboxClient(opts);
    await client.init();
    return client;
  }

  private async init() {
    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext();

    if (this.sid) {
      const { hostname } = new URL(this.host);
      await this.context.addCookies([
        {
          name: 'connect.sid',
          value: this.sid,
          domain: hostname,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);
    }
  }

  async close() {
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
  }

  private getContext(): BrowserContext {
    if (!this.context) throw new Error('Client is not initialized');
    return this.context;
  }

  async readText(pageTitle: string) {
    const ctx = this.getContext();
    const apiPath = `/api/pages/${encodePathSegment(this.project)}/${encodePathSegment(pageTitle)}/text`;
    const res = await ctx.request.get(`${this.host}${apiPath}`);
    if (!res.ok()) throw new Error(`Request failed: ${res.status()} ${res.statusText()}`);
    return await res.text();
  }

  async readJson(pageTitle: string) {
    const ctx = this.getContext();
    const apiPath = `/api/pages/${encodePathSegment(this.project)}/${encodePathSegment(pageTitle)}`;
    const res = await ctx.request.get(`${this.host}${apiPath}`);
    if (!res.ok()) throw new Error(`Request failed: ${res.status()} ${res.statusText()}`);
    return await res.json();
  }

  async list(opts: ListOptions = {}) {
    const ctx = this.getContext();
    const limit = opts.limit ?? 100;
    const skip = opts.skip ?? 0;
    const apiPath = `/api/pages/${encodePathSegment(this.project)}?limit=${encodeURIComponent(String(limit))}&skip=${encodeURIComponent(String(skip))}`;
    const res = await ctx.request.get(`${this.host}${apiPath}`);
    if (!res.ok()) throw new Error(`Request failed: ${res.status()} ${res.statusText()}`);
    return await res.json();
  }

  async append(pageTitle: string, body: string, waitMs = 1500) {
    const ctx = this.getContext();
    const page = await ctx.newPage();
    const url = new URL(`${this.host}/${encodePathSegment(this.project)}/${encodePathSegment(pageTitle)}`);
    url.searchParams.set('body', body);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    await page.close();
  }
}

function normalizeHost(host: string) {
  return host.replace(/\/$/, '');
}

function encodePathSegment(s: string) {
  return encodeURIComponent(s);
}
