//! Static host guidance and user-selected MCP prompt; no API calls or interpretation.
use crate::Repo;
use rmcp::model::{
    GetPromptRequestParams, GetPromptResult, Prompt, PromptArgument, PromptMessage, Role,
};
use rmcp::ErrorData;

pub const PROMPT_NAME: &str = "review_repository";
pub const WORKFLOW: &str = include_str!("../docs/repository-review-workflow.md");

pub fn definition() -> Prompt {
    Prompt::new(
        PROMPT_NAME,
        Some("Review an explicitly selected repository: in-graph branch/commit/file history first, then user-selected diff drill-down. User scope and host approvals take precedence; fetching this template performs no GitHub requests."),
        Some(vec![
            PromptArgument::new("repository")
                .with_description("Explicit GitHub.com OWNER/REPO, not a URL, path, or inferred target.")
                .with_required(true),
            PromptArgument::new("scope")
                .with_description("overview (default): in-graph history, bounded file metadata, no patch until user selection; graph_only: no file requests; list_only: no graph or diff requests.")
                .with_required(false),
        ]),
    )
}

pub fn get(request: GetPromptRequestParams) -> Result<GetPromptResult, ErrorData> {
    let invalid = || ErrorData::invalid_params("Invalid repository review prompt arguments", None);
    if request.name != PROMPT_NAME
        || request.input_responses.is_some()
        || request.request_state.is_some()
    {
        return Err(invalid());
    }
    let args = request.arguments.unwrap_or_default();
    if args
        .keys()
        .any(|key| !matches!(key.as_str(), "repository" | "scope"))
    {
        return Err(invalid());
    }
    let repository = args
        .get("repository")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    let repository = Repo::parse(repository).map_err(|_| invalid())?;
    let scope = match args.get("scope") {
        None => "overview",
        Some(serde_json::Value::String(s))
            if matches!(s.as_str(), "overview" | "graph_only" | "list_only") =>
        {
            s
        }
        _ => return Err(invalid()),
    };
    let scope_instruction = match scope {
        "graph_only" => "図のみ。repository_commit を呼ばず、代表fileとdiffを取得しない。",
        "list_only" => "一覧のみ。図を描かず、repository_commit を呼ばず、diffを取得しない。",
        _ => "標準レビュー: 図内に変更履歴と短い要約を置き、利用者の選択・追加質問後だけ実diffを深掘りする。",
    };
    Ok(GetPromptResult::new(vec![PromptMessage::new_text(
        Role::User,
        format!("対象repo: {}\n選択scope: {scope}\n今回の指定: {scope_instruction}\n利用者のより具体的な指示とhostの権限・承認を優先する。\n\n{WORKFLOW}", repository.0),
    )]).with_description("Host-GPT repository review workflow; no observations were collected by prompts/get."))
}
