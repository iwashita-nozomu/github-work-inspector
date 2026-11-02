# Chat / Work共通取得アダプタ: 既存GitHub app

CHATとCODEXの両方で、明示選択した同じrepoを既存GitHub appの許可範囲内で読む。
local stdio MCP/Rust/追加サーバーはこの共通入口の必須依存にしない。新規OAuth・権限・認証変更はしない。
応答はGPTへ到着するため、Rustの取得前マスキングと同等とは説明しない。

短い「このレポを見て」でも共通の全文探索手順を使う。最初にsearch_repositoriesで正確なrepoとdefault_branchを確認し、
search_branches({owner,repo_name,query:"",page_size:100})をcursor:nullまで全頁保持する。
`branch_pages`、`tip_resolutions`、`history_commits`、`reading` を元入力に保存し、normalizeChat→Acquisition.planを繰り返す。
requestsをhostが既存toolで実行し、tasksの本文をGPTが実際に読み/解釈し、その根拠を記録する。
Reading.receipt/pageReceiptへ正しい要求と実応答を渡す。GET成功だけではfile_reviews/branch_reviewsを生成しない。
PR/recent commitsは補助標本であり全枝の内容/履歴の代替ではない。

初期調査は全枝tipの必要な全文と全変更本文、設定・文書・テスト・結果・実call paths。
commit patchの深掘りは選択後という二段階を保つ。Annexはpathと固定commitの対応だけで十分。
取得能力不足なら未取得/未読/未解釈を説明し、connector代替やテキスト出力を専用機能/描画の成功にしない。

## 実装済みテンプレートで表示する（必須の完了条件）

1. `references/overview.fragment.html` と `references/review-selection.js` を読み、表示可能なnative Visualizeへ渡す。
   markup/検索/ページ切替/panelを毎回作り直さない。`/*__REVIEW_BUNDLE__*/`へbundleをinline、
   `/*__REVIEW_MODEL__*/`へ {captured_at,snapshot,summaries} のJSONを入れる。
   JSONの `< > & U+2028 U+2029` はUnicode escapeする。外部文字列をscript/HTMLへ直挿入しない。
   GitHubReviewOverview.buildFragment(template,bundle,model)がこの置換を実装している。
   実行可能環境では `node scripts/render-overview.cjs --model MODEL.json --out VIEW.html` も同じ関数を使う。
2. template内のmountが全枝カード、検索、20件単位のページ切替、常時既定基準、内容coverage、短い説明、
   選択時のSHA固定file根拠panelを生成する。描画payloadのfile抜粋は480文字に短縮し、全文や全diffを同梱しない。事前panel作成やonSelect callbackは不要。
   file選択はChat path locator。内容抜粋とcommit差分は異なる。選択だけでは取得しない。
3. native描画できなければ**図は未表示**と明記し、取得済み全枝一覧+根拠+参照付き質問を最小代案にする。
   テキスト表やZIP登録を可視化成功と呼ばない。HTMLファイルを作っただけでも会話内表示済みではない。
   対応ホストでもrollout/bridgeをfeature-detect。実環境の成功をfixtureから推測しない。

## 選択後の差分

「詳しく聞く」は明示クリック時だけhost bridgeを呼び、未提供/拒否なら参照付き質問を手動コピーする。
ユーザーがcommit差分を要求した後だけfetch_commitを使う。このtoolは全commit差分を返し得てfile/byte上限なし。
**選択file限定転送を保証できない**と事前表示し、file限定が条件なら呼ばず能力不足を報告する。
完全SHAと実filenameをnormalizeChatCommitへ渡し、選択1file・120行/16KiB表示に限定。秘密らしいpatchは表示しない。
parents/status/rename情報がない応答で補完を捏造しない。PR差分とcommit親差分も区別する。
取得成功/JSON検査/source testと、native実描画/選択送信/live GPT受入は別に報告する。
