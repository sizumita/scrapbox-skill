#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ScrapboxClient } from './client.js';

function usage() {
  console.log(`
Scrapbox/Cosense CLI (Playwright)

USAGE:
  scrapbox-skill login --project <name> [--headless false]
  scrapbox-skill read --project <name> --page <title>
  scrapbox-skill read-json --project <name> --page <title>
  scrapbox-skill list --project <name> [--limit 100] [--skip 0]
  scrapbox-skill search --project <name> --query "keyword" [--limit 100] [--skip 0]
  scrapbox-skill append --project <name> --page <title> --body "text"
  scrapbox-skill append --project <name> --page <title> --body-file /path/to/file
  echo "text" | scrapbox-skill append --project <name> --page <title>
  scrapbox-skill patch --project <name> --page <title> --diff-file file.diff
  cat file.diff | scrapbox-skill patch --project <name> --page <title>

OPTIONS:
  --project <name>   Project name (or SCRAPBOX_PROJECT / COSENSE_PROJECT)
  --page <title>     Page title
  --query <text>     Search query
  --body <text>      Body to append (URL-encoded automatically)
  --body-file <path> Read body from file
  --sid <value>      connect.sid cookie (or SCRAPBOX_SID / COSENSE_SID)
  --host <url>       Default: https://scrapbox.io (or SCRAPBOX_HOST / COSENSE_HOST)
  --headless <bool>  Default: true (loginはfalse推奨)
  --wait <ms>        Wait after open (append/patch). Default: 1500
  --json             Output JSON (list)
  --diff <text>      Unified diff text (patch)
  --diff-file <path> Unified diff file (patch)
  --check-updated    Abort if page updated before patch
  --fuzz <n>         Apply patch with fuzz (default 0)
  --dry-run          Do not edit; output patched text
`);
}

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean | string[]> = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

function requireValue(name: string, value?: string) {
  if (!value) {
    console.error(`Missing required: ${name}`);
    process.exit(1);
  }
  return value;
}

async function readStdin() {
  return new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function getBody(opts: Record<string, any>) {
  if (opts['body-file']) {
    return await fs.readFile(opts['body-file'], 'utf8');
  }
  if (opts.body) return opts.body as string;
  if (!process.stdin.isTTY) {
    return await readStdin();
  }
  return '';
}

const CRED_PATH = path.join(os.homedir(), '.openclaw', 'credentials', 'scrapbox-skill.json');

type StoredCred = { host: string; sid: string; project?: string; savedAt?: string };

async function getDiff(opts: Record<string, any>) {
  if (opts['diff-file']) {
    return await fs.readFile(opts['diff-file'], 'utf8');
  }
  if (opts.diff) return opts.diff as string;
  if (!process.stdin.isTTY) {
    return await readStdin();
  }
  return '';
}

async function loadStoredSid(host: string) {
  try {
    const raw = await fs.readFile(CRED_PATH, 'utf8');
    const data = JSON.parse(raw) as StoredCred;
    if (data?.host === host && data.sid) return data.sid;
  } catch {
    // ignore
  }
  return undefined;
}

async function saveStoredSid(host: string, sid: string, project?: string) {
  const dir = path.dirname(CRED_PATH);
  await fs.mkdir(dir, { recursive: true });
  const payload: StoredCred = { host, sid, project, savedAt: new Date().toISOString() };
  await fs.writeFile(CRED_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

async function waitForEnter() {
  return new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });
}

async function loginAndSaveSid(host: string, project: string, headless: boolean) {
  if (!process.stdin.isTTY) throw new Error('login requires interactive terminal');
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = new URL(`${host}/${encodeURIComponent(project)}`);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  console.error('ブラウザでログインできたら Enter を押してね');
  await waitForEnter();
  const cookies = await context.cookies(host);
  const sid = cookies.find((c) => c.name === 'connect.sid')?.value;
  await browser.close();
  if (!sid) throw new Error('connect.sid not found (login failed?)');
  await saveStoredSid(host, sid, project);
  console.error(`connect.sid saved: ${CRED_PATH}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    usage();
    process.exit(0);
  }

  const command = argv[0];
  const opts = parseArgs(argv.slice(1));

  const project = (opts.project as string) || process.env.SCRAPBOX_PROJECT || process.env.COSENSE_PROJECT;
  const host = (opts.host as string) || process.env.SCRAPBOX_HOST || process.env.COSENSE_HOST || 'https://scrapbox.io';
  const headless = String(opts.headless ?? 'true') !== 'false';

  if (command === 'login') {
    const loginHeadless = opts.headless !== undefined ? String(opts.headless) !== 'false' : false;
    await loginAndSaveSid(host, requireValue('project', project), loginHeadless);
    return;
  }

  let sid = (opts.sid as string) || process.env.SCRAPBOX_SID || process.env.COSENSE_SID;
  if (!sid) sid = await loadStoredSid(host);

  const client = await ScrapboxClient.create({ project: requireValue('project', project), sid, host, headless });

  try {
    if (command === 'read' || command === 'read-json') {
      const pageTitle = requireValue('page', (opts.page as string) || (opts.title as string) || (opts._ as string[])[0]);
      if (command === 'read') {
        const text = await client.readText(pageTitle);
        process.stdout.write(text);
      } else {
        const json = await client.readJson(pageTitle);
        process.stdout.write(JSON.stringify(json, null, 2));
      }
      return;
    }

    if (command === 'list') {
      const limit = opts.limit ? Number(opts.limit) : 100;
      const skip = opts.skip ? Number(opts.skip) : 0;
      const data = await client.list({ limit, skip });
      if (opts.json) {
        process.stdout.write(JSON.stringify(data, null, 2));
      } else {
        for (const p of data.pages || []) console.log(p.title);
      }
      return;
    }

    if (command === 'search') {
      const query = requireValue('query', (opts.query as string) || (opts.q as string) || (opts._ as string[])[0]);
      const limit = opts.limit ? Number(opts.limit) : 100;
      const skip = opts.skip ? Number(opts.skip) : 0;
      const data = await client.search(query, { limit, skip });
      if (opts.json) {
        process.stdout.write(JSON.stringify(data, null, 2));
      } else {
        for (const p of data.pages || []) console.log(p.title);
      }
      return;
    }

    if (command === 'append') {
      const pageTitle = requireValue('page', (opts.page as string) || (opts.title as string) || (opts._ as string[])[0]);
      const body = await getBody(opts);
      if (!body) {
        console.error('Missing body (use --body / --body-file / stdin).');
        process.exit(1);
      }
      const waitMs = opts.wait ? Number(opts.wait) : 1500;
      await client.append(pageTitle, body, waitMs);
      return;
    }

    if (command === 'patch') {
      const pageTitle = requireValue('page', (opts.page as string) || (opts.title as string) || (opts._ as string[])[0]);
      const diffText = await getDiff(opts);
      if (!diffText) {
        console.error('Missing diff (use --diff / --diff-file / stdin).');
        process.exit(1);
      }
      const waitMs = opts.wait ? Number(opts.wait) : 1500;
      const fuzz = opts.fuzz ? Number(opts.fuzz) : 0;
      const checkUpdated = Boolean(opts['check-updated']);
      const dryRun = Boolean(opts['dry-run']);
      const result = await client.patch(pageTitle, diffText, { fuzz, checkUpdated, waitMs, dryRun });
      if (dryRun && typeof result === 'string') {
        process.stdout.write(result);
      }
      return;
    }

    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err?.message || err);
  process.exit(1);
});
