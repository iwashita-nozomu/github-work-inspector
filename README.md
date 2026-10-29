# github-work-inspector

Codex Work から、アクセス権のある任意の **GitHub.com リポジトリ** の基本情報を
読み取るための、小さな Python 標準ライブラリ CLI と repo 内 Skill です。
最初のバージョンは、既存の `gh` 認証を利用した repository metadata の取得に限定します。

## 初期範囲

- 実装済み: `OWNER/REPO` を指定し、`GET /repos/OWNER/REPO` を1回呼び出す。
- 取得項目: 正式名、GitHub URL、公開範囲、既定ブランチ名、アーカイブ・無効化・
  テンプレート状態、主な言語、star・fork・open issue の件数、作成・更新・push日時。
- **未実装**: ブランチ一覧、コミットDAG、Issue本文・一覧、PR、CI、GUI、専用の可視化。
  既定ブランチ名や件数は基本メタデータとしてのみ含みます。
- Webサーバー、待受ポート、ブラウザの認証情報保管、AI API呼び出しはありません。
- GitHub Enterprise Server の独自ホストは初期対象外です。

## 必要な環境と使い方

Python 3.10 以上、GitHub CLI `gh`、対象へのアクセス権を持つ既存の `gh` 認証が必要です。
Python の追加パッケージやインストール手順は不要です。checkout のルートで実行します。

```sh
python3 -m github_work_inspector --help
python3 -m github_work_inspector repo --help
python3 -m github_work_inspector repo OWNER/REPO --json
```

`python` が Python 3.10 以上を指す環境では `python -m github_work_inspector ...` でも動きます。
`OWNER/REPO` は実際の対象へ置き換えてください。URLは受け付けません。
owner は英数字・単一ハイフンの1〜39文字、repo は英数字・`_`・`.`・`-` の1〜100文字。
owner の先頭・末尾ハイフン、連続ハイフン、repo の `.`・`..`、余分な `/`、空白、
制御文字、クエリなどは拒否します。

結果とエラーは1行の JSON を標準出力へ返します。現在は `--json` 省略時も同形式です。
`--help` のみ通常のヘルプ文を返します。取得データはファイルへ自動保存しません。

```json
{"schema_version":1,"captured_at":"2026-01-01T00:00:00Z","ok":false,"error":{"code":"gh_failed","message":"GitHub metadata request failed. Check access, existing gh authentication, and network."}}
```

成功時は `ok: true` と `repository` オブジェクト、失敗時は `ok: false` と `error` を返します。
`captured_at` は実行環境で結果を構成した時刻（UTC）で、GitHub上の更新時刻ではありません。
成功時の `repository` は次のキーを持ちます。

```text
name_with_owner, url, visibility, default_branch, archived, disabled, is_template,
language, stars, forks, open_issues, created_at, updated_at, pushed_at
```

`language`・`default_branch`・`pushed_at` は `null` の場合があります。
`open_issues` は GitHub の `open_issues_count` をそのまま表し、PRも含む件数です。
将来出力形式を変える場合に備えて `schema_version` を確認してください。

| 終了コード | 意味 |
| --- | --- |
| 0 | 取得成功、またはヘルプ表示 |
| 1 | `gh_unavailable`、`gh_failed`、`timeout`、`invalid_response` |
| 2 | `invalid_arguments`、`invalid_repository` |

認証・ネットワーク・存在しない対象・権限不足の詳細は `gh_failed` にまとめます。
必要なら利用者が `gh auth status` で既存認証を確認してください。このCLIは認証を作成・変更しません。

## Codex Work と Skill

明示呼び出し用の Skill は `.agents/skills/github-work-inspector/` にあります。
この checkout を扱う、対応した Codex 環境で `$github-work-inspector` を明示的に呼び出してください。
`agents/openai.yaml` の `allow_implicit_invocation: false` で自動選択を無効にしています。

Work の実行環境にも、この checkout と Python・`gh`・対象への既存アクセス権が必要です。
Mac の認証やファイルはクラウドへ自動共有されません。接続先や Skill の読み込み機能が
利用できない Work 環境では、そのまま実行できません。この repo はグローバル Skill の
インストール、Work への登録、権限追加を自動で行いません。

## 実行上の制約

外部コマンドは引数配列・`shell=False` で起動し、ホストを `github.com`、HTTPメソッドを
GET に固定します。タイムアウトは20秒。認証は `gh` の既存設定または既存の環境変数に委ねます。
子プロセスのデバッグ出力を無効にし、標準エラー・例外の詳細は結果へ転送しません。
返すフィールドを限定し、ownerプロフィール、連絡先、説明文、APIの生データを出力しません。
URLは検証済みの正式名から組み立てます。APIのリダイレクトで対象が改名・移転済みの場合は
取得した正式名が返ります。

CLIは読み取れる対象の内容を権限なく共有するためのものではありません。出力の保存・共有は
利用者が判断してください。fixtureには架空データだけを使い、会話、認証情報、実データの
スナップショットをrepoへ含めません。

API仕様は [GitHub REST: Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository)、
実行オプションは [gh api](https://cli.github.com/manual/gh_api) を参照。
APIバージョンは `2022-11-28` に固定しています。
対応状況は [GitHub API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions) を参照してください。

## オフラインテスト

```sh
python3 -m unittest discover -s tests -v
```

`gh` 起動をモックし、固定GET、引数検証、JSON形式、応答検証、タイムアウト、エラーの秘匿、
出力フィールドの限定を確認します。テストはネットワークや実際の認証を使用しません。

ライセンスは未決定です。LICENSEファイルは追加していません。
