---
name: scrapbox-skill
description: PlaywrightでScrapbox/Cosenseのページを読み書き（非公開はconnect.sid）。ページ本文の取得・一覧取得・末尾追記をCLIで行う時に使う。
---

# Scrapbox Skill

## Overview
Playwright（headless）でScrapbox/Cosenseを読み書きするローカルCLI＋TSライブラリ。非公開は `connect.sid` で認証する。

## セットアップ（初回のみ）
```bash
cd {baseDir}
(pnpm install || npm install)
npx playwright install chromium
npm run build
```

## 使い方（CLI）
**環境変数（推奨）**
- `SCRAPBOX_PROJECT`（または `COSENSE_PROJECT`）
- `SCRAPBOX_SID`（または `COSENSE_SID`）: `connect.sid`
- `SCRAPBOX_HOST`（または `COSENSE_HOST`）: 省略時 `https://scrapbox.io`

### connect.sid をWebログインで保存
```bash
node {baseDir}/dist/cli.js login --project "プロジェクト名" --headless false
```

保存先: `~/.openclaw/credentials/scrapbox-skill.json`
（以降は `--sid` を省略可能）

### 読み取り（テキスト）
```bash
node {baseDir}/dist/cli.js read --page "タイトル"
```

### 読み取り（JSON）
```bash
node {baseDir}/dist/cli.js read-json --page "タイトル"
```

### 一覧
```bash
node {baseDir}/dist/cli.js list --limit 100 --skip 0
```

### 追記（作成/末尾追加）
```bash
node {baseDir}/dist/cli.js append --page "タイトル" --body "本文"
# または
cat note.txt | node {baseDir}/dist/cli.js append --page "タイトル"
```

### 差分パッチ適用（カーソル操作で部分更新）
```bash
node {baseDir}/dist/cli.js patch --page "タイトル" --diff-file changes.diff --check-updated
# または
cat changes.diff | node {baseDir}/dist/cli.js patch --page "タイトル"
```

## 使い方（TSライブラリ）
```ts
import { ScrapboxClient } from "./dist/index.js";

const client = await ScrapboxClient.create({
  project: process.env.SCRAPBOX_PROJECT!,
  sid: process.env.SCRAPBOX_SID,
});
const text = await client.readText("タイトル");
await client.append("タイトル", "追記本文");
await client.close();
```

## 注意点
- `append` は `?body=` を使うため **既存ページは末尾追記**。
- `patch` は **内部APIがあればそれを優先**、無ければ行単位のカーソル操作で部分更新（DOMやエディタ変更で壊れる可能性あり）。
- `connect.sid` は秘匿。ログや返答に出さない。
- デバッグ時は `--headless false` を使う。
