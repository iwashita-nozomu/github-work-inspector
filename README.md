# github-work-inspector

認可済みの任意の GitHub.com repo を、Codex から読み取り把握する Rust CLI と
明示呼び出し用 Skill。HTTPサーバー・待受ポート・WebView・AI API・新しい認証は使いません。
通信は、既存認証済み `gh` を引数配列で起動する固定GETだけです。

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
gh release download v0.2.1 --repo iwashita-nozomu/github-work-inspector --pattern '*aarch64-apple-darwin*'
shasum -a 256 -c github-work-inspector-v0.2.1-aarch64-apple-darwin.tar.gz.sha256
tar -xzf github-work-inspector-v0.2.1-aarch64-apple-darwin.tar.gz
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

本文・CIログ・ownerプロフィール・連絡先・生URL・一時clone tokenは出力しません。
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
offline smokeし、archiveとSHA256を1日保持のartifactへ出力。cacheは作りません。
このPublic repoの標準GitHub-hosted runnerを使用します。larger runner・有料オプションは使いません。保護設定は変更しません。
releaseはworkflowから自動作成せず、検証済みartifactと実機確認済みMac archiveを
同一commitのタグへ載せます。対応ターゲットと検証範囲は各Release説明が正となります。
SHA256は破損検出用で第三者署名ではありません。Mac版はDeveloper ID署名・notarizeなしです。
OSが実行を拒否した場合は保護を自動で弱めず、利用者へ報告します。

GitHub仕様: [repository](https://docs.github.com/en/rest/repos/repos#get-a-repository)、
[commits](https://docs.github.com/en/rest/commits/commits)、[checks](https://docs.github.com/en/rest/checks/runs)、
[statuses](https://docs.github.com/en/rest/commits/statuses)、[gh api](https://cli.github.com/manual/gh_api)。
APIは `2022-11-28` 固定。Cargo.lockで依存を固定しています。

自作コードは [MIT](LICENSE)、Copyright (c) 2026 iwashita-nozomu。
依存物をMITへ再ライセンスするものではありません。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
と `third-party/` にCargo.lock全依存とRust標準ライブラリのライセンス・著作権通知を保持し、
全archiveへ同梱します。再配布時も通知を保持してください。Rustは1.99.1に固定しています。
