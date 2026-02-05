# scrapbox-skill

Playwright を使って Scrapbox/Cosense を読み書きする **CLI + TypeScript ライブラリ**。
非公開プロジェクトは `connect.sid`（Cookie）で認証します。

> 注意: 公式APIではなく **内部APIやWeb UI** を利用しています。変更で壊れる可能性あり。

## 特徴
- ページ本文の取得 / JSON取得 / 一覧 / 検索
- 末尾追記（`?body=`）
- **diffパッチ適用**（内部API優先、無ければカーソル操作で部分更新）
- Webログインで `connect.sid` を保存

## セットアップ
```bash
pnpm install || npm install
npx playwright install chromium
npm run build
```

## 環境変数
- `SCRAPBOX_PROJECT` / `COSENSE_PROJECT`
- `SCRAPBOX_SID` / `COSENSE_SID`（connect.sid）
- `SCRAPBOX_HOST` / `COSENSE_HOST`（既定: https://scrapbox.io）

## ログイン（connect.sid を保存）
```bash
node dist/cli.js login --project "プロジェクト名" --headless false
```
保存先: `~/.openclaw/credentials/scrapbox-skill.json`

## CLI 使い方
### 読み取り（テキスト）
```bash
node dist/cli.js read --page "タイトル"
```

### 読み取り（JSON）
```bash
node dist/cli.js read-json --page "タイトル"
```

### 一覧
```bash
node dist/cli.js list --limit 100 --skip 0
```

### 検索
```bash
node dist/cli.js search --query "keyword" --limit 100 --skip 0
```
※ 検索APIが通らない場合は、一覧から簡易フィルタにフォールバックします。

### 追記（作成/末尾追加）
```bash
node dist/cli.js append --page "タイトル" --body "本文"
# または
cat note.txt | node dist/cli.js append --page "タイトル"
```

### diffパッチ適用（部分更新）
```bash
node dist/cli.js patch --page "タイトル" --diff-file changes.diff --check-updated
```

diff例（unified diff）:
```diff
--- a/2026-02-04
+++ b/2026-02-04
@@ -1,2 +1,2 @@
 2026-02-04
-テスト開始
+テスト終了
```

## TSライブラリ利用
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
- **connect.sid は秘匿**（ログや共有に出さない）
- `patch` は **内部APIがあればそれを優先**、無ければ行単位のカーソル操作
- 内部API/DOM変更で壊れる可能性あり

## License
MIT（予定）
