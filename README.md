# github-work-inspector

認可済みの任意の GitHub.com repo を、Codex から読み取り把握する Rust CLI・stdio MCP と
明示呼び出し用 Skill をまとめたローカルプラグイン。HTTPサーバー・待受ポート・WebView・AI API・新しい認証は使いません。
通信は、既存認証済み `gh` を引数配列で起動する固定GETだけです。

## 図内履歴から選択して深掘り（開発版0.5.0）

プラグインを明示選択し「このレポを見て」と頼むと、ホストGPTはbranch/commit/変更fileと短い要約を
会話内のnative図へまとめます。初回は最大2commit・各5fileのmetadataまでで、patchを自動取得しません。
図で変更を選び「詳しく聞く」と、完全SHA/file_idを含む質問をnative hostへ渡し、必要な選択diffだけを
根拠に説明します。選択だけでは取得や新しい会話を開始しません。「一覧だけ」「図だけ」「差分不要」を優先します。

この標準はpackaged Skill、MCP initialize.instructions、tools/listの説明に実装しています。
明示取得用のMCP prompt `review_repository` も提供します（repository必須、scopeはoverview/graph_only/list_only）。
prompts/get自体はGitHubへアクセスせず、取得ツールは既存4種類のままです。

選択橋渡しはfeature-detectした `window.openai.sendFollowUpMessage` を使い、hostの確認を待ちます。
選択stateの保存だけでは次発言への伝達は保証されません。APIがない場合は参照付き質問をコピーする代案を示し、
クリックが会話へ伝わったとは偽りません。native図がなければ未表示と明記します。
[標準契約](docs/repository-review-workflow.md) と [短い入力の合成受入fixture](docs/examples/review-scenarios.json) を参照してください。
このPRのoffline検証はlive GPT・native実画面の受入とは別です。公開済みReleaseはv0.4.0で、下記導入例もその版です。

## Codex プラグインとして導入

Release の `github-work-inspector-plugin-v0.4.0-<TARGET>` archive と同名 `.sha256` を
取得して照合し、空の作業フォルダへ展開します。CLI 単体 archive とプラグイン archive は別です。
SHA256 は破損検出で、配布元の署名認証ではありません。取得元はこの repo の versioned Release に固定してください。

```sh
# Apple Silicon Mac の例。Windows は zip / Get-FileHash / Expand-Archive を使用
sha256sum -c github-work-inspector-plugin-v0.4.0-aarch64-apple-darwin.tar.gz.sha256
# macOS の標準コマンドでは上行を shasum -a 256 -c に置換
tar -xzf github-work-inspector-plugin-v0.4.0-aarch64-apple-darwin.tar.gz
cd github-work-inspector
python3 install-plugin.py
codex plugin add github-work-inspector@personal-local --json
codex plugin list --json
```

導入補助に Python 3.11+ が必要です。CLI/MCP の実行は Rust バイナリと既存の `gh` だけです。
補助スクリプトは `~/plugins/github-work-inspector` にソースを置き、
`~/.agents/plugins/marketplace.json` に1項目を登録します。既存 marketplace の名前・項目は保全し、
既存の名前が personal-local 以外なら出力された identity を `codex plugin add` に使います。
Codex の正式 CLI が cache と自プラグインの有効化を管理します。補助スクリプトは cache・認証・
グローバル安全設定を編集しません。既存ソース・異なる登録・symlink は拒否します。

導入後は **新しい Codex セッション** で `$github-work-inspector-plugin` を明示指定します。
既存の単独 Skill `$github-work-inspector` は削除せず併存できます。
ツールは `list_repositories`、`repository_metadata`、`repository_snapshot` と、新しい `repository_commit` です。既存の3ツール allowlist は自動で変更しません。
`repository_snapshot` の例: `{"repository":"OWNER/REPO","branches":2,"commits":6,"pages":1}`。
root `plugin.json` / `mcp.json` と Codex 互換 `.codex-plugin/plugin.json` / `.mcp.json` を同梱。
起動は プラグイン root を基準とする `./bin/github-work-inspector mcp`（Windows は `.exe`）、HTTP は使いません。

更新は新 Release を照合・展開し、そのフォルダで `python3 install-plugin.py --update`、
続いて同じ `codex plugin add ... --json` を実行します。厳密なファイル hash 確認により編集・追加を
検出したら停止します。旧ソースと marketplace は backup を残します。
導入途中の I/O 失敗では旧ソースと marketplace を復元し、新候補を `.failed-*` へ退避します。
lock は handle を閉じた上で解放します。復元自体が I/O エラーの場合は成功と扱わず、残った
source・backup・failed の状態を確認してください。通常の rollback は Codex の
`plugin remove` 後、backup を別途確認して元へ戻し、同じ identity を再導入します。
削除は `codex plugin remove github-work-inspector@personal-local --json`。
元ソース・backup・marketplace 登録は自動削除しません。不要なら内容確認後に対象項目と
`~/plugins/github-work-inspector` だけを手動で片付けてください。単独 CLI/Skill の削除は下記の別操作です。

個人 local marketplace の自動更新 toggle/cadence は確認できていません。
Git marketplace の `codex plugin marketplace upgrade <name>` は手動更新です。
この配布はローカルのビルド済みバイナリを使うため、上記の明示的な Release 更新を使います。
独自 daemon/cron/launchagent は追加しません。workspace 管理の GitHub 日次同期とは別機能です。
将来の更新も実行可能コードを置き換えるため、更新元・差分を確認してください。
[安全性と検知後の対応](docs/security.md) も参照してください。

## 使う

```sh
github-work-inspector repos --limit 20
github-work-inspector inspect OWNER/REPO
github-work-inspector inspect OWNER/REPO --json
github-work-inspector repo OWNER/REPO --json
github-work-inspector inspect OWNER/REPO --branches 8 --commits 20 --pages 2 --checked-prs 5 --json
```

`repos` は既存アカウントからアクセスできるrepo一覧。`--owner NAME` は指定ユーザーの
repoをpushed順で列挙します。対象は `OWNER/REPO`。URL・パス・任意ホストは受け付けません。
GitHub Enterprise Server は対象外。取得結果のファイル自動保存はありません。
Python版はRust版に置換しました。`python -m github_work_inspector` は廃止です。

人向け表示はbranchのtip、`child -> parents` のDAG、Issue/PRの状態とCIを表示します。
DAGはSHA順で、親が取得範囲外なら `?` を付けます。時系列・topological順とは限りません。
branch間で重複するcommitを統合し、各branchの取得範囲と打切りを記録します。

## 選択した commit → file → diff

```sh
# 完全長40/64桁のSHAだけ。repo指定はこれまで通り。
github-work-inspector commit OWNER/REPO FULL_SHA --limit 10 --json
# 一覧の index を選ぶ。選択した1ファイルの patch だけを返す。
github-work-inspector commit OWNER/REPO FULL_SHA --mode patch --file-index 2 --file-id FILE_ID --patch-lines 120 --patch-bytes 16384 --json
```

新 MCP `repository_commit` は repository / sha を必須にし、mode は files（既定）/patch。
patch モードでは一覧の file_id も必須です。番号が別ファイルを指す場合は表示せず失敗します。
file_index は0〜2999、一覧 limit は1〜20（既定10）、patch_lines は1〜400（既定120）、
patch_bytes は1〜65536（既定16384）。既存と同じ timeout_seconds / budget_seconds を使用。
必要な GitHub 権限は Contents read。既存認証だけを使用し、権限は追加しません。
**patch は実際のソース差分をモデルのコンテキストに返します。** 非公開コードを選ぶ際は
その共有範囲を確認してください。秘密らしい内容は省略しますが完全な秘匿検出ではありません。

GET commit JSON を `per_page=1&page=index+1` で読みます。選択commitの一覧も最大20件の
1ファイルページに限定。API は各ページにそのファイルの patch を含むことがありますが、
一覧モードでは破棄し返却・保存しません。全 commit の diff/patch media type、clone、
任意 URL、ローカルファイル、shell、追加 AI API は使用しません。

追加・変更・削除・rename と previous_filename、additions/deletions/changes を API 観測値で返します。
完全SHAとファイル番号は次の明示取得に渡す値で、短縮SHAは表示ラベルだけです。
削除ファイルの新blobリンクは作りません。旧blobは単一親の完全SHAと観測した旧pathがある場合だけ。
merge の API patch は **比較親未確定** と明記し、親別比較をしたとは扱わず、旧blobリンクを作りません。
初期commitはempty-tree基準。API patch の完全性は保証できず、バイナリ/大きすぎる差分/未提供を
欠落した patch だけから区別しません。上限・途中失敗・3000ファイル API cap・観測時刻を明示します。

patch は制御文字/方向制御文字を除き、秘密らしい値・秘密ファイル・大きすぎる入力は全体を省略。
行/byte打切りと理由を記録し、HTML用の escaped text も返します。データを実行せず、事実と AI 解釈を分離します。
意味要約はホスト Codex GPT が実根拠から作ります。定型キーワードエンジンや追加GPT APIは使いません。
何を変更・確認できる理由・限定された影響を説明し、未確認の意図は推定として分けます。
[意味要約の合成例と受入基準](docs/semantic-review.md) を参照。
画面は chat 内の native visualize を優先し、取得だけで描画済みと扱いません。
commit/file の選択は取得済みデータの切替か、次の明示ツール取得。描画HTMLから通信しません。
native visualize が使えなければ未達と伝え、静的な file一覧/diff を代替表示します。

既存の3ツール制限は自動で拡張しません。新版の導入と新ツール有効化は
別途レビュー後に行います。**ブロックされた新ツールをCLIで迂回してはいけません。**

## インストール / 更新 / 削除

本repoとReleaseはPublic、プロジェクトの自作部分はMITです。バイナリ利用にRustは不要。
取得対象が非公開の場合は、その対象への既存アクセス権を持つ `gh` が必要です。
[Releases](https://github.com/iwashita-nozomu/github-work-inspector/releases) からターゲットを選びます。
Mac Apple Silicon: `aarch64-apple-darwin`、Linux x64: `x86_64-unknown-linux-gnu`、
Windows x64: `x86_64-pc-windows-msvc`。公開済みassetが実在するものだけが配布対象です。
Intel Mac、Linux arm64等はこの版のビルド済み配布対象外です。

macOS / Linuxの例（タグとターゲットは使用するReleaseに合わせる）:

```sh
mkdir gwi-download
cd gwi-download
gh release download v0.4.0 --repo iwashita-nozomu/github-work-inspector --pattern '*aarch64-apple-darwin*'
shasum -a 256 -c github-work-inspector-v0.4.0-aarch64-apple-darwin.tar.gz.sha256
tar -xzf github-work-inspector-v0.4.0-aarch64-apple-darwin.tar.gz
./github-work-inspector --version
./github-work-inspector install
~/.local/bin/github-work-inspector inspect OWNER/REPO --json
```

Windows PowerShellでは `.zip` と `.zip.sha256` を取得し、`Get-FileHash -Algorithm SHA256`
の結果を `.sha256` と照合して `Expand-Archive` します。展開先の
`./github-work-inspector.exe install` を実行してください。Windowsの既定binも
`$HOME/.local/bin`、Skillは `$HOME/.agents/skills/github-work-inspector`。
PATH・シェル・Codex設定は変更しません。必要ならフルパスで呼び出します。

導入先変更は `--bin-dir PATH --skill-root PATH`。`--skill-root` はSkillの親フォルダです。
既存ファイルや同名Skillがあれば拒否します。導入はバイナリと埋め込みSkillの2ファイル、
管理manifestだけを作り、`.install.json` にバージョンとファイルhashを記録します。

```sh
# 更新は新Releaseを検証・展開したフォルダで実行
./github-work-inspector install --update
# 削除（カスタム導入なら同じ --bin-dir / --skill-root を指定）
~/.local/bin/github-work-inspector uninstall
```

更新・削除はmanifestと現在のhashが一致する管理対象だけに行います。編集や追加ファイルが
ある場合は拒否し、利用者の変更を残します。中断時に `.gwi-*-old-*` 等が残っている場合は
状態を確認して復旧してください。Windowsでは実行中のexeを置換・削除できないため、
展開先の別コピーから `install --update` / `uninstall` を実行します。

## Codex から呼ぶ

```text
$github-work-inspector OWNER/REPO のブランチとPR/CIの状況を確認して。
```

Skillは `~/.agents/skills/github-work-inspector` に導入し、明示呼び出しだけを許可。
repo内の `.agents/skills/github-work-inspector` と同名Skillが両方見える場合は対象を選びます。
変更を検知しない場合はCodexを再起動。読み込み場所は
[公式OpenAI Skillドキュメント](https://learn.chatgpt.com/docs/build-skills) を参照。

Workの別クラウド環境にはMacのバイナリ・Skill・認証は自動共有されません。
その環境にも対応バイナリと既存認証済み `gh` が必要です。認証の配布、クラウド登録、
権限拡大は行いません。

## 観測範囲と欠落

| 項目 | 既定 / 上限 |
| --- | --- |
| branch | 6 / 20 |
| branchごとのcommit | 12 / 100 |
| Issue・PR・workflow run | 各20 / 各100 |
| チェックするopen PR | 5 / 20、0で省略 |
| collectionごとのページ | 2 / 5、各ページ最大100件 |
| PRごとのcheck runs・commit statuses | 各100件まで |
| request timeout | 20秒 / 60秒 (`--timeout-seconds`) |
| 全体の通信時間予算 | 120秒 / 300秒 (`--budget-seconds`) |
| 応答サイズ | 1request最大8MiB、stderr最大64KiB |

branchはAPI列挙順で標本化し、commitは観測したtip SHAから取得する祖先の有限範囲。
Issue/PRは更新順・全state、runはAPIの返却順です。`issues` endpointに混在するPRを
除外し、除外数を記録します。ページ上限までPRしかない場合はIssue未列挙の可能性があります。
branch数・commit数は全repoの総数ではありません。

各sectionの `coverage` に件数・ページ数・`has_more`・打切り理由・全列挙できたかを記録。
`has_more: null` は取得失敗等で未確定です。空配列を「存在しない」と即断しないでください。
取得失敗は部分取得として残りの取得可能なsectionを返し、時間予算超過後は追加通信をしません。

PR checksは標本内のopen PRを更新順に選び、観測head SHAの最新check-runsとcombined
commit statusesを取得。空チェックを「成功」と推定しません。必須チェックの保護ルール・
mergeability・IssueとPRの関連付けは未照会です。run/check/statusは独立したAPI観測値で、
merge可能性やIssue完了を推定しません。

複数GETは原子的snapshotではなく、取得中に状態が変わる可能性があります。
ルートの `captured_at`、snapshotの開始/終了、metadataと各sectionの観測時刻を確認します。
API観測情報だけを返し、`inferences` は空配列です。

## JSON とエラー

`--json` は `schema_version: 1`、`captured_at`（UTC）、`ok` を持つ1行JSON。
`repo` の `repository` はPython初版のキーを保持。新コマンドは `snapshot` / `repositories`、
導入操作は `installation`。ルート失敗は `error: {code,message}`。
詳細は [docs/json.md](docs/json.md)。通常表示は人向けテキストです。

| 終了コード | 意味 |
| --- | --- |
| 0 | 依頼した範囲の取得成功、導入成功、help/version。上限打切りはcoverage参照 |
| 1 | 全体の取得失敗、応答異常、導入失敗 |
| 2 | コマンド・範囲・`OWNER/REPO` が不正 |
| 3 | 部分取得。成功sectionと各errorを確認 |

`not_found` は不存在と非公開対象の権限不足を区別できません。
`access_denied`、`rate_limited`、`timeout`、`budget_exhausted`、`response_too_large`、
`gh_unavailable`、`gh_failed`、`invalid_response` は固定説明だけを返します。
API応答・gh stderr・例外・認証情報の生出力は転送せず、自動リトライや認証変更もしません。

Issue/PR本文・CIログ・ownerプロフィール・連絡先・生URL・一時clone tokenは出力しません。
タイトル等は信頼しないデータとして制御文字/方向制御文字を除去し、代表的credential形式を
秘匿して240文字までに制限します。任意の自由文に埋め込まれた秘密の完全な自動判定はできません。
非公開結果の保存・共有には利用者の判断が必要です。CLI自身は内容を実行しません。

## 開発・CI・配布

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --offline
RUSTFLAGS="--remap-path-prefix=$PWD=." cargo build --release --locked
python3 scripts/licenses.py --check
python3 scripts/package.py --target aarch64-apple-darwin --binary target/release/github-work-inspector
```

テストは架空fixtureとfake `gh`を使い、ネットワークや実認証を使いません。
初回依存取得は `cargo fetch --locked`。CLI利用時にPythonやRustは不要です。
開発用packaging scriptのみPython 3.11以上を使います。

`.github/workflows/build.yml` は手動実行でLinux/Windowsをfmt・clippy・test・release build・
offline smokeし、CLI / plugin archiveとSHA256を1日保持のartifactへ出力。cacheは作りません。
このPublic repoの標準GitHub-hosted runnerを使用します。larger runner・有料オプションは使いません。
releaseはworkflowから自動作成せず、検証済みartifactと実機確認済みMac archiveを
同一commitのタグへ載せます。対応ターゲットと検証範囲は各Release説明が正となります。
SHA256は破損検出用で第三者署名ではありません。Mac版はDeveloper ID署名・notarizeなしです。
OSが実行を拒否した場合は保護を自動で弱めず、利用者へ報告します。

push/通常 PR の verify、RustSec の日次検査、CodeQL の週次/変更時検査は別 workflow です。
Dependabot は Cargo と SHA 固定 Action の更新 PR を毎日確認します。無検証 merge はしません。

GitHub仕様: [repository](https://docs.github.com/en/rest/repos/repos#get-a-repository)、
[commits](https://docs.github.com/en/rest/commits/commits)、[checks](https://docs.github.com/en/rest/checks/runs)、
[statuses](https://docs.github.com/en/rest/commits/statuses)、[gh api](https://cli.github.com/manual/gh_api)。
APIは `2022-11-28` 固定。Cargo.lockで依存を固定しています。

自作コードは [MIT](LICENSE)、Copyright (c) 2026 iwashita-nozomu。
依存物をMITへ再ライセンスするものではありません。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
と `third-party/` にCargo.lock全依存とRust標準ライブラリのライセンス・著作権通知を保持し、
全archiveへ同梱します。再配布時も通知を保持してください。Rustは1.99.1に固定しています。
