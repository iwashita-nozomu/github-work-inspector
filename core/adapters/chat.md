# 共通入口の取得アダプタ: 接続済みGitHub app（Chat / Work）

このaccount SkillはCHATとCODEXの両方で既存GitHub appを使う。local stdioを必須依存にしない。
従来のWork Rust版は任意の別取得アダプタであり、この入口がRustを実行したと偽らない。
書込みtoolを使わず、新規OAuth/認証/権限/サーバーを要求しない。このSkill自体はACLではない。
GitHub appの応答はGPTへ届く。正規化/表示時の秘密省略はRustの取得前マスキングと同等ではない。

## 標準入力「このレポを見て」の必須処理

短い入力でも、枝名だけの表・PRだけの表・描画なしを完了扱いしない。利用者の「一覧だけ」等は優先する。
`references/review-selection.js` の共通normalize/Survey.planと、下記の取得順を使う。
JSを実行できない取得turnでは同じ契約をhostが適用し、JS実行済みとは言わない。次のnative fragmentの
scriptでは実際に正規化と描画を実行する。取得の実行主体は常にhostであり、viewからtoolを呼ばない。

1. search_repositoriesの完全一致repository_full_nameとdefault_branchを確認。mainという枝名から既定枝を決めない。
2. search_branches({owner,repo_name,query:"",page_size:100})の**全branches**を保持し、返ったcursorをそのまま次へ渡す。
   空応答でもcursorがあれば未終端。cursor:nullまで、最大10頁/1000枝。反復cursor/上限/失敗時はpartialと理由を明示。
   ページごとのbranches/cursor/captured_atを残す。取得枝数=正規化枝数=全表示対象数を検査し、表示1頁20件と混同しない。
   既定枝が後ろにあっても消さず、基準欄へ常時表示。範囲外/未取得ならその事実を残す。
3. 共通核の「全枝を網羅する探索順」に従う。既定枝を先に限定調査・要約してから、残りを固定順で巡回する。
   Survey.planのrequestsはhostが既存GitHub appで実行し、各応答で再正規化する。
   tip_resolutionsは{ref,captured_at,result}、失敗は{ref,captured_at,error:"tip_resolution_failed"}。
   branch_readsはref/sha/captured_at/comparisonまたはcomparison_error/filesを保持する。
   filesはpath/start_line:1/end_line:60/captured_at/contentまたはerror。基準側の代表fileは
   baseline_files:[{sha:BASE_FULL_SHA,path,start_line:1,end_line:60,captured_at,contentまたはerror}] に記録する。
   基準側は同一repo/基準完全SHAへ固定。比較resultのbase/headも完全SHAと照合する。
4. README+代表fileは各60行/表示8KiB、基準側追加1fileまで。秘密らしいpath/内容、data、巨大成果物を避け、
   取得不能や不足は明示する。既知のCMakeLists.txt probe失敗時に別path総当たりはしない。
   providerの行範囲制限を応答で確認する。raw内容をログ/公開fixtureへ保存しない。
5. branch_summariesで各refの目的と違いを記録し、全枝のexploration状態・未確認数・再開位置を図内へ表示する。
   要約はfile証拠に固定し、同じREADMEだけから枝固有の違い・意図・完了を断定しない。
   normalizeChatへ全branch_pages/tip_resolutions/branch_reads/branch_summariesを渡す。
   request_budgetで止まっても未着手枝を落とさず、checkpointと観測一式を保持する。

PR（search_prs最大20件）とrecent commits（search_commits最大8件）は補助標本。枝ref引数のないrecentは
全枝の履歴ではない。exact head repo/refでのみPRを関連付ける。parents未提供はnull、DAGの線を作らない。

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
