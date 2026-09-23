# アーキテクチャ

## 方針

ビルド工程を持たない静的PWAのまま、変更理由ごとにファイルを分けています。HTMLは構造、CSSは見た目、`src` は振る舞いを担当します。計算と保存契約は `app-core.js` に集約し、ブラウザに依存しない形でテストします。

## ファイル構成

| ファイル | 責務 |
| --- | --- |
| `index.html` | 通常版の固定マークアップと読込順 |
| `compact.html` | コンパクト版の固定マークアップと読込順 |
| `styles/main.css` | 通常版の基本表示・設定画面・レスポンシブ表示 |
| `styles/compact.css` | コンパクト版の表示 |
| `styles/appearance.css` | 共通ライト／ダーク配色、カードと固定操作エリア |
| `src/appearance.js` | 独立したテーマ設定、端末時刻による切替と画面復帰 |
| `assets/ui-icons.svg` | 意味別アイコンと同サイズのバイク用SVGスプライト |
| `src/app-core.js` | 定数、保存キー、進捗計算、終了上限、区間集計、日時・時間整形 |
| `src/main-app.js` | 通常版の入力、カード、設定、画面描画、旧時計互換 |
| `src/compact-app.js` | コンパクト版の入力・描画と通常版との同期 |
| `src/session-engine.js` | 連続時計、休憩・他社稼働、履歴、稼働終了 |
| `src/session-editors.js` | 開始時刻・休憩時間の編集ダイアログ |
| `src/data-backup.js` | 保存データのJSON書き出し・読み込み（キーと形式はそのまま複製） |
| `sw.js` | オフラインキャッシュと更新世代 |
| `tests/` | 計算、保存互換、時計、同期、UI契約の回帰テスト |

## 読込順

両画面ともhead内で`appearance.js`を読み、初回描画前にテーマを適用します。配達処理は通常版で次の順に読み込みます。

1. `app-core.js`
2. `main-app.js`
3. `session-engine.js`
4. `session-editors.js`

`quest-ui.js`と`data-backup.js`はその後に読み込みます。

後段は前段の公開値や画面要素を利用します。順番を変更する場合は、依存関係を先に解消してください。コンパクト版は `app-core.js`、`compact-app.js` の順です。

## データの流れ

1. 通常版またはコンパクト版がフォーム値と時計状態を読み込む。
2. `app-core.js` の純粋関数で進捗を計算する。
3. 各画面が結果を描画する。
4. 利用者操作時のみ正本データを localStorage へ保存する。
5. 別画面は `storage`、`pageshow`、`visibilitychange` で状態を再調整する。

表示用に秒を分へ丸めても、正本の `remainingMs` は丸めて書き戻しません。これにより通常版・コンパクト版の往復で秒が失われない設計です。

## 変更時の境界

- 数式、定数、区間集計を変える場合は、まず `app-core.js` と `app-core.test.js` を変更する。
- 通常版だけの表示・操作は `main-app.js`、コンパクト版だけなら `compact-app.js` を変更する。
- 時計の状態遷移や履歴は `session-engine.js`、編集UIは `session-editors.js` を変更する。
- localStorageのキーや形式を変える場合は、旧データからの明示的な移行と互換テストを追加する。
- 配信ファイルを追加・変更したら、HTMLの `?v=`、`sw.js` のキャッシュ世代、`ASSETS` を同時に更新する。

## 既知の設計上の判断

- `main-app.js` の `remain`・`syncClock`・`stopClock`・`saveClock`・`loadClock` は旧時計（`ubereatsProgressClockState`）の互換処理。起動時だけ動き、`session-engine.js` が旧データを連続時計へ移行するために使う。その後は `session-engine.js` が置き換える。`adjustRemain`・`toggleClock` は置き換え先の宣言だけを残している。
- localStorageへの時計の書き込みは `app-core.js` の `storeItems` を通す。失敗時は関連キーを元に戻し、通知は失敗が続く間1回だけにする。バックアップ復元中は書き込みを止め、再読み込み前の時計が復元データを上書きしないようにする。
- Service Workerは画面遷移だけクエリを無視して照合し、それ以外は `?v=` まで完全一致で照合する。クエリを無視した照合はオフライン時の代替だけに使う。

- フレームワークやバンドラーは導入していない。GitHub Pagesへそのまま配信でき、障害点を増やさないため。
- `app-core.js` はブラウザのグローバルとCommonJSの両方に公開する。追加依存なしでNode.jsテストを実行するため。
- UI契約の一部はDOMの軽量テストとソース契約テストで保護する。実機Safariの最終確認を完全には代替しない。
