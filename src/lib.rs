pub mod client;
pub mod inspect;
pub mod install;
pub mod render;

use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Error {
    pub code: String,
    pub message: String,
}

impl Error {
    pub fn new(code: &str) -> Self {
        let message = match code {
            "invalid_repository" => "Expected a GitHub.com OWNER/REPO identifier.",
            "invalid_arguments" => "Invalid command or arguments. Use --help.",
            "gh_unavailable" => "Unable to start the existing gh CLI.",
            "timeout" => "A GitHub request exceeded its time limit.",
            "budget_exhausted" => "Snapshot time budget exhausted; remaining data is unavailable.",
            "not_found" => {
                "Repository or resource is absent or inaccessible to the existing authentication."
            }
            "access_denied" => "Existing authentication cannot read this resource.",
            "rate_limited" => "GitHub rate limit reached; no automatic retry was attempted.",
            "response_too_large" => "GitHub response exceeded the size limit.",
            "invalid_response" => "GitHub returned an invalid response.",
            "install_conflict" => "Existing or edited files prevent a managed installation change.",
            "install_io" => {
                "Installation filesystem operation failed; inspect the requested destinations."
            }
            "not_installed" => "No matching managed installation was found.",
            _ => "GitHub request failed. Check existing authentication, access, and network.",
        };
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub struct Repo(pub String);

impl Repo {
    pub fn parse(value: &str) -> Result<Self> {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        let re = PATTERN.get_or_init(|| {
            Regex::new(
                r"\A([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/([A-Za-z0-9_.-]{1,100})\z",
            )
            .unwrap()
        });
        let captures = re
            .captures(value)
            .ok_or_else(|| Error::new("invalid_repository"))?;
        if captures[1].contains("--") || matches!(&captures[2], "." | "..") {
            return Err(Error::new("invalid_repository"));
        }
        Ok(Self(value.into()))
    }
    pub fn endpoint(&self) -> String {
        format!("repos/{}", self.0)
    }
    pub fn url(&self) -> String {
        format!("https://github.com/{}", self.0)
    }
}

pub fn sha(value: &str) -> Result<String> {
    if matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(Error::new("invalid_response"))
    }
}

pub fn text(value: &str) -> String {
    static SECRETS: OnceLock<Regex> = OnceLock::new();
    let pattern = SECRETS.get_or_init(|| {
        Regex::new(concat!(
        r"(?i)(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|",
        r"AKIA[A-Z0-9]{16}|(?:bearer\s+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+|",
        r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
    )).unwrap()
    });
    let clean: String = value.chars().map(|c| {
        if c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}') { ' ' } else { c }
    }).collect();
    let redacted = pattern.replace_all(&clean, "[REDACTED]");
    let mut result: String = redacted.chars().take(240).collect();
    if redacted.chars().count() > 240 {
        result.push('…');
    }
    result
}

pub fn envelope(field: &str, value: Value, ok: bool) -> Value {
    let mut out = json!({"schema_version": 1, "captured_at": now(), "ok": ok});
    out[field] = value;
    out
}

pub fn error_envelope(error: Error) -> Value {
    envelope("error", serde_json::to_value(error).unwrap(), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha_algorithms_and_path_injection() {
        assert_eq!(sha(&"A".repeat(40)).unwrap(), "a".repeat(40));
        assert!(sha(&"b".repeat(64)).is_ok());
        for value in [
            "a".repeat(39),
            "a".repeat(41),
            "g".repeat(40),
            format!("{}?page=2", "a".repeat(40)),
        ] {
            assert!(sha(&value).is_err());
        }
    }

    #[test]
    fn multiline_credentials_and_unicode_are_safe_display_data() {
        let result =
            text("fixture\npassword=do-not-display\nBearer do-not-display\u{1b}\u{2066}日本語");
        assert!(!result.contains("do-not-display"));
        assert!(!result.chars().any(char::is_control));
        assert!(!result.contains('\u{2066}'));
        assert!(result.contains("日本語"));
    }
}
