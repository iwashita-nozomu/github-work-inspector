# GPTによる意味要約: 合成例と受入基準

意味の解釈はホスト Codex GPT が行う。Rustツールは事実/差分/coverageだけを供給し、
`inferences` は空のまま。追加AI APIも定型語によるsummary engineも作らない。
以下は公開してよい合成fixture (`docs/examples/semantic-commit.json`) の例で、
SHAもrepoも実在のGitHub根拠ではない。合成URLを実在する根拠リンクとして表示しない。

## 初期図と選択後を分ける

標準は[ブランチ俯瞰からの選択](repository-review-workflow.md)。初期図は枝ごとの目的・違い・観測状態を並べてから、
選んだ枝の履歴へ進む。短い要約は観測subject/関連PR抜粋/file metadataを根拠にし、patchは取得しない。
利用者がcommit/fileを選択して追加質問した後だけ、次の選択patchの意味解釈を行う。代表fileの別枠自動解説にはしない。
選択伝達はnative sendFollowUpMessageを用い、state保存だけで次発言へ届いたと扱わない。

## 十分な選択patchがある場合

完全SHAは `9` が40桁、file index 0は `src/settings.rs`。取得hunkは
`@@ -1,2 +1,2 @@`。timeout定数だけが10から20へ変わり、文脈内のMAX_RETRIESは0。
commit messageは “Allow slower requests”。著者の説明を真の原因/意図の確認と混同しない。

GPTの許容される説明例:

> 要求の待機時間を表す定数を10秒から20秒へ延ばしています（選択commit / src/settings.rs / index 0 / hunk +1,2）。
> この定数を使う呼び出しでは遅い応答を待てる一方、失敗判定が遅れる可能性があります。ただし呼び出し元は未取得です。
> commit messageから遅い要求を許容する狙いは推測できますが、実際の障害原因や改善効果は未確認です。

native図の選択詳細には「待機時間定数を20秒へ」の短い要約、上記根拠、条件付き影響と未確認事項を
表示する。単なる+1/-1行やfile名の列挙で済ませない。クリックで外部APIを呼ばず、未取得詳細は
次の明示repository_commit要求へ分ける。実データでは完全SHAと観測したfile/patchを用いる。

## patchが不足/省略された場合

秘密らしい内容、API未提供、binaryかlarge diffか不明、local truncation、途中失敗、merge比較親未確定を
それぞれ説明する。タイトルと追加/削除行数だけから実装内容・原因・影響を断定しない。
「変更fileと統計は取得済みだがpatchが省略され、何を直したかと影響は未確認」と説明し、
根拠を追加取得できる場合だけ次の明示選択を提案する。CLI迂回や権限拡張はしない。

## 受入確認

1. offline fixture testが選択SHA/file/index/hunkとcoverageを保持し、秘密省略とtruncationを区別する。
2. ホストGPTの説明は変更事実・推定・未知を分け、変更commit/file/hunkへ根拠を結び付ける。
3. 「バグが直った」「全呼出しで20秒」「リトライしない」「全利用者に無影響」はこのfixtureだけでは不合格。
4. native visualizeで図と選択詳細が実際に出たことを確認する。取得だけ/長文connectorだけは描画成功ではない。
   利用できないホストでは未達を明示し、readonly static一覧/diffで代替する。
5. 新MCP toolがhostで未許可なら有効化を待つ。意味要約の定型一致を自動テスト成功と称さない。

Rust fixture testは証拠の完全性を検証する。ホストGPTの意味解釈とnative描画は別の受入段階であり、
offline testからライブGPT/GUIの受入が済んだとは扱わない。

## native図の合成受入

合成branch名 `main` / `feature/timeout`、commit短ラベル `待機定数20秒` / `merge設定` を使う。
実観測時は実枝名と観測commitだけで置き換え、短縮SHAはラベル、full SHAは選択根拠に保持する。
mergeは線と親子が読めるcompact配置にし、番号1〜6だけの無名lane、無情報dot列、縦の間延びは不合格。
選択詳細で短い意味要約、file/index、完全commitとpatch範囲、未確認影響を図と同時に追う。
320 / 768 / 1024px と明/暗で表示・選択状態を確認する。labelが読めない、内容欠落、根拠が
別画面で追えない、snapshot取得だけで成功報告する場合は未達とする。私的なsnapshot/図/写真は使わない。
この文書は合成受入手順であり、未許可の新toolやnative図の実機受入を完了した記録ではない。

俯瞰の合成受入は [branch-overview.json](examples/branch-overview.json)。名前だけのプルダウン、
選ぶ前には目的が読めない画面、欠けたdefault branch、根拠なしの完了/未統合断定は不合格。
既定枝が一覧の上限後/次ページにあるケースでも基準を表示し、取得不能は明記する。
PRの同名fork・古いmerged headを区別し、説明根拠が欠ける/古いtipなら不明へ戻す。
通常Chat等で専用ツールが使えなければ実行経路と未達を表示し、connectorのPR表で成功扱いしない。
