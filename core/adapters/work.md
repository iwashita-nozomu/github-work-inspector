# Work取得アダプタ: Rust / 既存gh

専用MCPの `list_repositories` / `repository_metadata` / `repository_snapshot` / `repository_commit` だけを使う。
repository_snapshotの初回はbranches=4, commits=8, issues=5, prs=20, runs=5, checked_prs=2, pages=1程度。
Rustのreview_core.adapterはrust_gh。追加のtoolやhost allowlist変更は不要で、承認待ちはそのまま報告する。
stdio processはCodexコマンドsandbox外で動き、readOnly annotationsはOS隔離ではない。

枝一覧応答の最大100件を俯瞰に残し、詳細履歴は指定枝数だけ。既定枝は一覧内から優先し、ページ外なら
最大1回の固定GETで解決して最後の履歴標本枝と入れ替える。history:nullは未取得。各時刻/coverage/errorを保持する。
初期file metadataは許可されたrepository_commit filesを完全SHAで最大2commit・各limit=5まで。patchは取得しない。

file選択の追加質問後は、同じSHA/file_id/file_indexでpatch_lines=120, patch_bytes=16384程度の1fileだけを取得する。
commit選択はまず有限filesを示す。branch選択は観測tipの履歴だけを使い、未観測tip/枝を推測して呼ばない。
Work locatorはRustが観測したfile_id/indexで、Chatのpath locatorを直接このtoolへ渡さない。
Chat由来の選択をWorkで使うならfilesを再観測して元の完全SHA/pathに対応するfile_idへ解決し直す。
merge patchの比較親未確認をfirst-parentと決め付けない。API patch未提供はbinaryの証明ではない。
Rustは固定GET・有限timeout/budget・引数配列・秘密らしいpatchの省略を行うが、完全な秘密検知を保証しない。

明示的な単独CLI SkillではCLI JSON相当（inspect/repo/repos/commit）を使える。通常の配置は
`~/.local/bin/github-work-inspector`、カスタム配置はSkillの `.install.json` のbinaryをパス情報として確認する。
パス/引数は配列で扱う。プラグインで拒否されたMCP呼出しをCLIで迂回しない。
Macのbinary/gh認証が別のWork/Chatに自動共有されると仮定しない。導入/更新/削除はこのレビューの範囲外。

nativeの取得経路表示は専用MCPならoptions.source=plugin、明示CLIならcli。専用MCP不可の代替connectorは
connectorと示してWorkプラグイン成功に数えない。current taskのtool catalogが古ければ新しい対応セッションが必要。
