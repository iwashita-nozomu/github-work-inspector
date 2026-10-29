use crate::{now, Error, Result};
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_RESPONSE: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Page {
    pub data: Value,
    pub next: bool,
    pub observed_at: String,
}

pub trait Api {
    fn get(&mut self, endpoint: &str) -> Result<Page>;
}

pub struct Gh {
    deadline: Instant,
    timeout: Duration,
}

impl Gh {
    pub fn new(timeout: u64, budget: u64) -> Self {
        Self {
            deadline: Instant::now() + Duration::from_secs(budget),
            timeout: Duration::from_secs(timeout),
        }
    }
}

pub fn command(endpoint: &str) -> Command {
    let mut command = Command::new("gh");
    command.args([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        endpoint,
    ]);
    command
        .env_remove("GH_DEBUG")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn read_limited(reader: impl Read, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn classify_failure(stderr: &str) -> Error {
    let code = if stderr.contains("HTTP 429") || stderr.to_ascii_lowercase().contains("rate limit")
    {
        "rate_limited"
    } else if stderr.contains("HTTP 404") {
        "not_found"
    } else if stderr.contains("HTTP 401") || stderr.contains("HTTP 403") {
        "access_denied"
    } else {
        "gh_failed"
    };
    Error::new(code)
}

pub fn parse_response(raw: &[u8]) -> Result<Page> {
    let data = std::str::from_utf8(raw).map_err(|_| Error::new("invalid_response"))?;
    let normalized = data.replace("\r\n", "\n");
    let mut remaining = normalized.as_str();
    let mut headers = "";
    while remaining.starts_with("HTTP/") {
        let (block, body) = remaining
            .split_once("\n\n")
            .ok_or_else(|| Error::new("invalid_response"))?;
        headers = block;
        remaining = body;
    }
    if headers.is_empty() {
        return Err(Error::new("invalid_response"));
    }
    let next = headers.lines().any(|line| {
        line.to_ascii_lowercase().starts_with("link:") && line.contains("rel=\"next\"")
    });
    Ok(Page {
        data: serde_json::from_str(remaining).map_err(|_| Error::new("invalid_response"))?,
        next,
        observed_at: now(),
    })
}

impl Api for Gh {
    fn get(&mut self, endpoint: &str) -> Result<Page> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| Error::new("budget_exhausted"))?;
        let timeout = self.timeout.min(remaining);
        let mut child = command(endpoint)
            .spawn()
            .map_err(|_| Error::new("gh_unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| Error::new("gh_failed"))?;
        let stderr = child.stderr.take().ok_or_else(|| Error::new("gh_failed"))?;
        let out = thread::spawn(move || read_limited(stdout, MAX_RESPONSE));
        let err = thread::spawn(move || read_limited(stderr, 64 * 1024));
        let started = Instant::now();
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
                _ => {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let stdout = out
            .join()
            .map_err(|_| Error::new("gh_failed"))?
            .map_err(|_| Error::new("gh_failed"))?;
        let stderr = err
            .join()
            .map_err(|_| Error::new("gh_failed"))?
            .map_err(|_| Error::new("gh_failed"))?;
        if timed_out {
            return Err(Error::new("timeout"));
        }
        if stdout.len() as u64 > MAX_RESPONSE || stderr.len() > 64 * 1024 {
            return Err(Error::new("response_too_large"));
        }
        if !status.is_some_and(|s| s.success()) {
            return Err(classify_failure(&String::from_utf8_lossy(&stderr)));
        }
        parse_response(&stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhausted_budget_never_starts_a_process() {
        let error = Gh::new(20, 0).get("repos/example/project").unwrap_err();
        assert_eq!(error.code, "budget_exhausted");
    }
}
