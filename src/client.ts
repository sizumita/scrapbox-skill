import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { applyPatch, parsePatch, diffLines } from 'diff';

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

export type PatchOptions = {
  fuzz?: number;
  checkUpdated?: boolean;
  waitMs?: number;
  debug?: boolean;
  dryRun?: boolean;
};

type LineInfo = { id?: string; text: string };

type PatchOp =
  | { type: 'remove'; index: number; count: number }
  | { type: 'insert'; index: number; lines: string[] };

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

  async patch(pageTitle: string, diffText: string, opts: PatchOptions = {}): Promise<string | void> {
    const pageJson = await this.readJson(pageTitle);
    const baseUpdated = pageJson.updated;
    const lines = extractLines(pageJson);
    const originalText = linesToText(lines);

    const patch = parseFirstPatch(diffText);
    const newText = applyPatch(originalText, patch, { fuzzFactor: opts.fuzz ?? 0 });
    if (newText === false) throw new Error('Patch apply failed');

    if (opts.dryRun) return newText;

    if (opts.checkUpdated) {
      const latest = await this.readJson(pageTitle);
      if (latest.updated !== baseUpdated) {
        throw new Error('Page was updated before patch (updated mismatch)');
      }
    }

    const ops = buildOps(originalText, newText);
    if (ops.length === 0) return;

    const ctx = this.getContext();
    const page = await ctx.newPage();
    const url = new URL(`${this.host}/${encodePathSegment(this.project)}/${encodePathSegment(pageTitle)}`);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#editor .line', { state: 'attached' });
    if (opts.waitMs && opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);

    const newLines = splitLines(newText);
    const internal = await tryInternalPatch(page, newLines);
    if (!internal) {
      await page.click('#editor');
      await applyOps(page, ops, lines);
    }

    await page.close();

    const after = await this.readJson(pageTitle);
    const afterText = linesToText(extractLines(after));
    if (afterText !== newText) {
      throw new Error('Verification failed (content mismatch after patch)');
    }
  }
}

function normalizeHost(host: string) {
  return host.replace(/\/$/, '');
}

function encodePathSegment(s: string) {
  return encodeURIComponent(s);
}

function extractLines(pageJson: any): LineInfo[] {
  const lines = Array.isArray(pageJson?.lines) ? pageJson.lines : [];
  return lines.map((line: any) => ({ id: line.id, text: line.text ?? '' }));
}

function linesToText(lines: LineInfo[]): string {
  return lines.map((l) => l.text ?? '').join('\n');
}

function parseFirstPatch(diffText: string) {
  const patches = parsePatch(diffText);
  if (!patches.length) throw new Error('No patch found in diff');
  return patches[0];
}

function splitLines(value: string) {
  const lines = value.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function buildOps(originalText: string, newText: string): PatchOp[] {
  const changes = diffLines(originalText, newText);
  const ops: PatchOp[] = [];
  let index = 0;

  for (const part of changes) {
    const lines = splitLines(part.value);
    if (part.added) {
      if (lines.length) ops.push({ type: 'insert', index, lines });
      continue;
    }
    if (part.removed) {
      if (lines.length) ops.push({ type: 'remove', index, count: lines.length });
      index += lines.length;
      continue;
    }
    index += lines.length;
  }

  return ops;
}

type OpGroup = { removeCount: number; insertLines: string[] };

function groupOps(ops: PatchOp[]) {
  const groups = new Map<number, OpGroup>();
  for (const op of ops) {
    const group = groups.get(op.index) ?? { removeCount: 0, insertLines: [] };
    if (op.type === 'remove') {
      group.removeCount += op.count;
    } else {
      group.insertLines.push(...op.lines);
    }
    groups.set(op.index, group);
  }
  return groups;
}

async function applyOps(page: Page, ops: PatchOp[], lines: LineInfo[]) {
  const groups = groupOps(ops);
  const indices = [...groups.keys()].sort((a, b) => b - a);

  for (const index of indices) {
    const group = groups.get(index)!;
    if (group.removeCount > 0) {
      await deleteLines(page, index, group.removeCount, lines);
    }
    if (group.insertLines.length > 0) {
      await insertLines(page, index, group.insertLines, lines, group.removeCount);
    }
  }
}

async function deleteLines(page: Page, index: number, count: number, lines: LineInfo[]) {
  for (let i = 0; i < count; i++) {
    const lineInfo = lines[index + i];
    const line = await findLine(page, lineInfo, index);
    await line.scrollIntoViewIfNeeded();
    await focusLine(line);
    await selectAll(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(30);
  }
}

async function insertLines(page: Page, index: number, insertLines: string[], lines: LineInfo[], removedCount: number) {
  if (insertLines.length === 0) return;

  if (index === 0) {
    const anchorIndex = Math.min(index + removedCount, lines.length - 1);
    const anchorInfo = lines[anchorIndex];
    if (anchorInfo) {
      const anchor = await findLine(page, anchorInfo, anchorIndex);
      await anchor.scrollIntoViewIfNeeded();
      await focusLine(anchor);
      await moveToStart(page);
      await page.keyboard.press('Enter');
      await page.keyboard.insertText(insertLines.join('\n'));
      await page.waitForTimeout(30);
      return;
    }
  }

  const anchorIndex = Math.max(0, index - 1);
  const anchorInfo = lines[anchorIndex];
  const anchor = await findLine(page, anchorInfo, anchorIndex);
  await anchor.scrollIntoViewIfNeeded();
  await focusLine(anchor);
  await moveToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(insertLines.join('\n'));
  await page.waitForTimeout(30);
}

async function findLine(page: Page, info: LineInfo | undefined, index: number) {
  if (info?.id) {
    const selectors = [
      `#editor #L${info.id}`,
      `#editor [id="L${info.id}"]`,
      `[data-line-id="${info.id}"]`,
      `[data-id="${info.id}"]`,
      `[data-lineid="${info.id}"]`,
    ];
    for (const selector of selectors) {
      const loc = page.locator(selector);
      if ((await loc.count()) > 0) return loc.first();
    }
  }

  const byIndex = page.locator('#editor .line').nth(index);
  if ((await byIndex.count()) > 0) return byIndex;

  if (info?.text) {
    const byText = page.locator('#editor .line', { hasText: info.text });
    if ((await byText.count()) > 0) return byText.first();
  }

  throw new Error(`Line not found at index ${index}`);
}

async function focusLine(line: ReturnType<Page['locator']>) {
  const text = line.locator('.text');
  if ((await text.count()) > 0) {
    await text.first().click({ force: true });
    return;
  }
  await line.click({ force: true });
}

async function tryInternalPatch(page: Page, newLines: string[]) {
  try {
    const result = await page.evaluate(async (lines) => {
      const sb: any = (window as any).scrapbox;
      if (!sb?.Page?.updateLine || !sb?.Page?.insertLine || !sb?.Page?.waitForSave) return false;
      const current = (sb.Page.lines || []).map((l: any) => l?.text ?? '');
      const oldLen = current.length;
      const newLen = lines.length;
      const min = Math.min(oldLen, newLen);

      for (let i = 0; i < min; i++) {
        if (lines[i] !== current[i]) sb.Page.updateLine(lines[i], i);
      }
      if (newLen > oldLen) {
        for (let i = oldLen; i < newLen; i++) sb.Page.insertLine(lines[i], i);
      } else if (oldLen > newLen) {
        for (let i = oldLen - 1; i >= newLen; i--) sb.Page.updateLine('', i);
      }

      await sb.Page.waitForSave();
      return true;
    }, newLines);
    return Boolean(result);
  } catch {
    return false;
  }
}

async function selectAll(page: Page) {
  const isMac = process.platform === 'darwin';
  await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A');
}

async function moveToStart(page: Page) {
  const isMac = process.platform === 'darwin';
  await page.keyboard.press(isMac ? 'Meta+ArrowLeft' : 'Home');
}

async function moveToEnd(page: Page) {
  const isMac = process.platform === 'darwin';
  await page.keyboard.press(isMac ? 'Meta+ArrowRight' : 'End');
}
