# BLT LOG 閲覧版（Viewer）

チームBLTのスプラトゥーン3プラベ戦績ビューア。**表示専用**（AI機能・書き込み機能なし）。

## できること
- オーナー版が書き出した戦績データ（`BLTLOG2:` 形式の data.txt）の表示
  - MVP / 過去のプラベ結果（講評含む）/ 累計データ / 生態図鑑 / プレイヤーノート / 専属コーチ（共有された分析文）
- マッチング（チーム分け・抽選。データを書き込まないためそのまま利用可）
- ねずみスタジオ：オーナーが共有した写真（`BLTSTUDIO1:` 形式の studio.txt）の閲覧
- URLを一度登録すれば、**起動のたびに自動で最新データへ更新**（オフライン時はキャッシュ表示）

## デプロイ（Vercel）
```bash
npm install
npm run build        # 動作確認: npm run dev
npx vercel deploy    # または GitHubリポジトリをVercelにImport
```

## データの共有手順（オーナー側）
1. **戦績**: オーナー版の設定 → 共有テキストを書き出し（講評込み）→ GitHubの `data.txt` に貼って保存
2. **写真**: オーナー版のねずみスタジオ → 「閲覧版へ共有」→ できたテキストを `studio.txt` に貼って保存（写真を追加するたびに作り直して上書き）
3. 閲覧版の右下の歯車 → それぞれのGitHub raw URL（`https://raw.githubusercontent.com/...`）を登録

## ホーム画面に追加（PWA）
- 表示名は **「BLT LOG」**、アイコンはサンゴとグラフのオリジナルアイコン
- iPhone: Safariで開く → 共有 → ホーム画面に追加
- `public/manifest.json`, `apple-touch-icon.png`(180px), `icon-192/512.png` 設定済み

## 構成
- `src/App.jsx` … 本体（オーナー版から派生した単一コンポーネント）
- ストレージは localStorage（写真が容量を超えた分はメモリ保持＝次回起動時にURLから自動復元）
