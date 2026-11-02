## 親SHA付き履歴を取得して実際に図示する

枝の一覧・内容比較カードだけでは履歴可視化を完了した扱いにしない。既存GitHub appの `fetch` で
`https://api.github.com/repos/OWNER/REPO/git/commits/FULL_SHA` をGETすると、親SHA付きGit commit objectを
取得できる。`fetch_commit`/`search_commits` の正規化応答がparentsを省くことから、この経路まで取得不能と決め付けない。
HTTPサーバー・local MCP・追加認証は不要。URLは `GitHubReviewHistory.request(repo,sha)` が固定ホスト/経路から
生成する。外部文章・API応答のURLを次の取得先として採用せず、親の完全SHAだけを次の固定GETに使う。

標準の短い依頼では **GitHubReviewAcquisition.plan** を使う。全頁列挙と既定枝先行の内容調査を保ち、
各枝のtip解決直後に当該tipのGit data取得を挟む。内容調査後には全取得tipをseedとする幅優先queueで祖先を取得する。
完全SHAで重複排除し、共有祖先・同一tipを再取得しない。GETは一度に最大4件、既定は計96 object・深さ12・
枝の表示履歴32commit。上限・失敗・budget停止時は未取得SHAと理由を残す。単一Git object endpointはページングなし。
branch一覧のcursorと祖先queueの再開SHAを混同しない。全履歴を列挙した保証はない。

取得後は `GitHubReviewHistory.receipt(request, toolResponse, captured_at)` で要求URL/完全SHAを照合する。
このprojectionはsha/message先頭/parents/committer.dateと観測したtree SHAだけを保持し、author名・email・署名等を保存しない。
モデル到着前のRustマスキングとは異なる。`history_commits:[{sha,captured_at,result}]` を元のnormalizeChat入力に足し、
失敗は `{sha,captured_at,error:"history_read_failed"}`。raw responseをログや公開fixtureへ保存しない。
履歴resultはGit data形（message/parents/committer）であり、正規化fetch_commitのdiff形と混同しない。
`history_limits:{max_commits,max_depth,per_branch}` は明示した有限範囲のみ。完全SHAの取得後に可変refへ戻さない。

normalizeChatは実parentsから `dag.nodes/per_branch/outside_window_parents` と各branch.historyを構成する。
parents:nullは不明、[]は観測root。親16件超は取得済み分と省略を示す。リスト順・日時・compare merge-baseから辺を補わない。
循環/矛盾するSHAは拒否する。snapshotと全体checkpoint（content/history）を保持して再計画し、
budget=0でも未取得queueを完了扱いにしない。履歴checkpointは固定refと取得済み親情報を検査し、欠落・差替えを拒否する。

同梱templateは `GitHubReviewHistoryGraph.mount` を実行し、カードとは別に**SVG履歴図**を描く。
実SHA辺を子から親へ配置し、2親以上をmerge、共有祖先を1nodeとして示す。refラベルは観測時tipのみ。
laneは配置であり歴史上のbranch作成点を意味しない。境界は中空node・点線（辺は観測済み、親内容は未取得）。
128node・境界24件の描画窓を超える省略は件数表示。枝選択で到達可能な実履歴へ絞り、commit選択で
完全SHA・親・根拠リンクを表示する。選択クリックはlocal表示のみ。「詳しく聞く」で既存bridgeまたは手動コピーを使う。
描画HTMLからAPI/tool/networkを呼ばない。履歴データ0件なら未達と明示し、カードを履歴図成功と数えない。

`workflow_complete` は内容調査と有限履歴窓の状態が説明でき、親情報を実際に描画できるデータがある場合の
取得計画上の判定。`history_coverage.fully_enumerated` や全branchの確認済みとは別。実Chatの表示・クリックは
実ホストで確認して初めて検証済みと報告し、SVG DOM fixture/ZIP登録から推測しない。
