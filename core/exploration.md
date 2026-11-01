## 全枝を網羅する探索順・進捗・終了条件

共通入口の全体計画は `GitHubReviewAcquisition.plan(snapshot, options)`。内容調査の下位計画は `GitHubReviewSurvey.plan(snapshot, options)`、実行主体はhostである。
Skill/計画はホストの実行を強制する安全境界ではないが、名前を列挙しただけの未読状態で終了判定しない。
以下の順を変えず、各取得後に観測を保存して再正規化・再計画する。新しいサーバーや常駐処理は不要。

1. **全ページを先に列挙**。cursor:nullまで取得し、重複を除いた対象ref集合を確定する。
   plannerは次cursorがある間 `enumerate_all_pages` を返し、先に枝内容へ進まない。
   10頁/1000枝・反復cursor・取得失敗で止まる場合は、一覧そのものが部分的と表示したうえで既知の対象を固定する。
   取得数=正規化数=表示対象数を検査。未列挙の枝を取得済みや存在しない扱いにしない。
2. **観測した既定枝を先頭**、残りは正確なrefのUTF-16辞書順（locale非依存）に固定する。
   例: 既定枝 → feature/1 → feature/10 → feature/2。既定枝の名前をmainに固定しない。
   既定枝が最終ページや末尾でも最初に調べ、下記の限定調査と要約/状態記録が終わるまで次の枝へ進まない。
   既存の同一SHAの観測は再利用する。全tipだけを先に解決して内容未読のまま終了しない。
3. **各枝を順番に**: 同一ref比較でtip完全SHA固定 → Git dataで当該tipの親を観測 → 既定tipSHAとの比較 → READMEと安全な代表file取得
   → 変更がある場合は代表fileの基準SHA側も取得 → GPTの根拠付き目的・違いの要約/不足記録 → 次の枝。
   基準側は追加1file・60行/表示8KiBまで。同じrepo/SHA/path/行範囲と同じSHAペア比較のみcache再利用する。
   同じREADMEを読めたことやahead件数は枝固有の差分を読んだ証拠にならない。変更fileの両tipの限定行範囲を
   照合できなければ部分確認。これはcommit親patchや全diffを読んだ意味でもない。
   基準不明/比較不能/安全な変更fileなし/削除等で不足するときは理由を残す。親関係やSHAは補完しない。
4. **各refの要約を記録**。同一SHAならfile/比較を再利用できても、そのrefのsummary/statusを省略しない。
   `branch_summaries` は `{ref,sha,status:"recorded",purpose:{text,kind,evidence},difference:{text,kind,evidence}}`。
   変更ありのdifferenceは観測した両SHA側file evidence IDが必須。目的・違いを判断できない場合は
   `{ref,sha,status:"insufficient"}` を記録し、不明を架空の説明で埋めない。`tasks:summarize_branch` はhost GPT向け
   の固定計画項目であり新しいMCP tool/AI APIではない。観測factsと意味の推定を混ぜない。
5. **進捗を全枝分保持**。`exploration.rows` の state は未着手(not_started)、進行中(in_progress)、
   確認済(checked)、部分確認(partial)、取得不能(unavailable)。checkedは上記限定範囲と根拠付き要約が揃った状態で、
   全コード監査完了ではない。pending requestやsummary taskがある枝はterminal:falseのまま。
   失敗receiptは自動再試行せず、取得不能/部分確認と未読を区別する。in-flightも取得成功とは数えない。
6. **予算停止と再開**。`request_budget` は今回発行するGET件数（既定4、同時最大4）。0や
   `stop_reason:"budget"|"time"|"user"|"connection"` で止めると、未確認枝・pending key・再開ref/stageを返す。
   `checkpoint` と **同じ観測snapshot/入力receipt一式**を保持する。checkpoint単独にはfile内容は入らない。
   再開は `GitHubReviewAcquisition.plan(snapshot,{checkpoint,request_budget:...})`。対象集合、取得時刻、固定SHA、処理済receiptを検査し、
   repo違い・tip差替え・処理済根拠の欠落を拒否する。refが進んでも保存済みSHAを黙って現在tipへ変更しない。
   新しい枝/観測世代は別の探索として明示する。結果を無断で永続保存・公開しない。
7. **終了判定**。`acquired = processed + remaining` と5状態の合計を検査する。
   `not_confirmed = acquired - checked` は部分確認・取得不能・未着手・進行中を含む。
   全取得枝のterminal状態が説明できれば `finished_known_targets:true`。
   一覧終端も確認できた場合にだけ `complete:true`、さらに全枝checkedなら `all_checked:true`。
   GETが0件でもsummary taskや未読枝があれば終了ではない。partial/unavailableを含む巡回終了と全枝確認は別である。
   一覧が部分的なら既知の枝を全て処理しても全リポジトリを網羅したとは呼ばない。複数時点の非原子的観測も明示する。

内容調査の `complete` だけでは全体終了ではない。後述の親SHA付き履歴窓の取得・SVG表示も必要。全体checkpointはcontent/historyを束ね、旧内容checkpointも固定SHAを検査して引き継ぐ。
