use clap::{Args, Parser, Subcommand};
use github_work_inspector::{
    client::{Api, Gh},
    envelope, error_envelope,
    inspect::{self, Limits},
    install, render, Error, Repo, Result,
};
use serde_json::Value;
use std::io::{self, Write};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    version,
    about = "Read-only, bounded GitHub.com repository snapshots through existing gh authentication."
)]
struct Cli {
    #[arg(long, global = true, help = "Emit the versioned JSON envelope.")]
    json: bool,
    #[arg(long,global=true,default_value_t=20,value_parser=clap::value_parser!(u64).range(1..=60))]
    timeout_seconds: u64,
    #[arg(long,global=true,default_value_t=120,value_parser=clap::value_parser!(u64).range(5..=300))]
    budget_seconds: u64,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Read one repository's basic metadata.
    Repo { repository: String },
    /// Read bounded branches, commit DAG, issues, pull requests, and CI observations.
    Inspect {
        repository: String,
        #[arg(long,default_value_t=6,value_parser=clap::value_parser!(u16).range(1..=20))]
        branches: u16,
        #[arg(long,default_value_t=12,value_parser=clap::value_parser!(u16).range(1..=100))]
        commits: u16,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u16).range(1..=100))]
        issues: u16,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u16).range(1..=100))]
        prs: u16,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u16).range(1..=100))]
        runs: u16,
        #[arg(long,default_value_t=5,value_parser=clap::value_parser!(u16).range(0..=20))]
        checked_prs: u16,
        #[arg(long,default_value_t=2,value_parser=clap::value_parser!(u16).range(1..=5))]
        pages: u16,
    },
    /// List accessible repositories; choose a name for repo/inspect. --owner lists a user's repositories.
    Repos {
        #[arg(long)]
        owner: Option<String>,
        #[arg(long,default_value_t=20,value_parser=clap::value_parser!(u16).range(1..=100))]
        limit: u16,
        #[arg(long,default_value_t=2,value_parser=clap::value_parser!(u16).range(1..=5))]
        pages: u16,
    },
    /// Install this binary and explicit-only Codex skill without changing existing configuration.
    Install {
        #[command(flatten)]
        paths: Paths,
        #[arg(
            long,
            help = "Replace only an intact installation recorded by this tool."
        )]
        update: bool,
    },
    /// Remove only an intact managed binary and skill. Edited/unrelated files are preserved by refusal.
    Uninstall {
        #[command(flatten)]
        paths: Paths,
    },
}

#[derive(Args)]
struct Paths {
    #[arg(long, help = "Binary directory; default ~/.local/bin.")]
    bin_dir: Option<PathBuf>,
    #[arg(long, help = "Skill parent directory; default ~/.agents/skills.")]
    skill_root: Option<PathBuf>,
}

fn execute(cli: Cli) -> Result<(Value, i32)> {
    let mut api = Gh::new(cli.timeout_seconds, cli.budget_seconds);
    match cli.command {
        Commands::Repo { repository } => {
            let repo = Repo::parse(&repository)?;
            let page = api.get(&repo.endpoint())?;
            Ok((
                envelope("repository", inspect::repository(&page.data)?, true),
                0,
            ))
        }
        Commands::Inspect {
            repository,
            branches,
            commits,
            issues,
            prs,
            runs,
            checked_prs,
            pages,
        } => {
            let repo = Repo::parse(&repository)?;
            let limits = Limits {
                branches: branches.into(),
                commits: commits.into(),
                issues: issues.into(),
                pulls: prs.into(),
                runs: runs.into(),
                checked_pulls: checked_prs.into(),
                pages: pages.into(),
            };
            let (snapshot, partial) = inspect::snapshot(&mut api, &repo, &limits)?;
            Ok((
                envelope("snapshot", snapshot, !partial),
                if partial { 3 } else { 0 },
            ))
        }
        Commands::Repos {
            owner,
            limit,
            pages,
        } => {
            let section =
                inspect::repositories(&mut api, owner.as_deref(), limit.into(), pages.into())?;
            let partial = section.error.is_some();
            Ok((
                envelope(
                    "repositories",
                    serde_json::to_value(section).unwrap(),
                    !partial,
                ),
                if partial { 3 } else { 0 },
            ))
        }
        Commands::Install { paths, update } => {
            let (binary, skill) = install::destinations(paths.bin_dir, paths.skill_root)?;
            Ok((
                envelope(
                    "installation",
                    install::install(&binary, &skill, update)?,
                    true,
                ),
                0,
            ))
        }
        Commands::Uninstall { paths } => {
            let (binary, skill) = install::destinations(paths.bin_dir, paths.skill_root)?;
            Ok((
                envelope("installation", install::uninstall(&binary, &skill)?, true),
                0,
            ))
        }
    }
}

fn output(value: &Value, json: bool) {
    let string = if json {
        format!("{}\n", serde_json::to_string(value).unwrap())
    } else {
        render::human(value)
    };
    // Broken pipes are normal when output is consumed by a pager or another CLI.
    let _ = io::stdout().lock().write_all(string.as_bytes());
}

fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
    let json = args.iter().any(|s| s == "--json");
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error) => {
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                let _ = error.print();
                std::process::exit(0);
            }
            output(&error_envelope(Error::new("invalid_arguments")), json);
            std::process::exit(2);
        }
    };
    let (value, code) = match execute(cli) {
        Ok(result) => result,
        Err(error) => {
            let code = if matches!(
                error.code.as_str(),
                "invalid_arguments" | "invalid_repository"
            ) {
                2
            } else {
                1
            };
            (error_envelope(error), code)
        }
    };
    output(&value, json);
    std::process::exit(code);
}
