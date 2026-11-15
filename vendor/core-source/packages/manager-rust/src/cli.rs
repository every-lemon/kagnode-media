//! Shared CLI entry point for the standalone manager and KagNode Daemon.
use crate::{Manager, server};
use anyhow::{Result, ensure};
use clap::Subcommand;
use serde_json::{Value, json};
use std::path::PathBuf;
#[derive(Subcommand)]
pub enum Command {
    Serve,
    Bind {
        application: String,
        #[arg(long)]
        uid: u32,
        #[arg(long)]
        gid: u32,
        #[arg(long)]
        baseline: String,
    },
    Status {
        application: String,
    },
    Check {
        application: String,
    },
    Apply {
        application: String,
        #[arg(long)]
        release_id: Option<u64>,
    },
    Rollback {
        application: String,
    },
    Policy {
        application: String,
        #[arg(long)]
        expected_revision: u64,
        #[arg(long)]
        automatic: Option<bool>,
        #[arg(long)]
        summaries: Option<bool>,
        #[arg(long,value_parser=["stable","beta"])]
        channel: Option<String>,
    },
    Adopt {
        application: String,
        #[arg(long)]
        lock_file: PathBuf,
        #[arg(long)]
        expected_baseline: String,
    },
}
pub fn run(root: PathBuf, command: Command) -> Result<Value> {
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "Run the reviewed Core manager through root or its private application sockets"
    );
    let m = Manager::new(root)?;
    match command {
        Command::Serve => {
            server::serve(m)?;
            Ok(json!({"stopped":true}))
        }
        Command::Bind {
            application,
            uid,
            gid,
            baseline,
        } => m.bind(&application, uid, gid, &baseline),
        Command::Status { application } => m.status(&application),
        Command::Check { application } => m.check(&application),
        Command::Apply {
            application,
            release_id,
        } => m.apply(&application, release_id, false),
        Command::Rollback { application } => m.rollback(&application),
        Command::Adopt {
            application,
            lock_file,
            expected_baseline,
        } => m.adopt(&application, &lock_file, &expected_baseline),
        Command::Policy {
            application,
            expected_revision,
            automatic,
            summaries,
            channel,
        } => {
            let mut input = json!({"expected_revision":expected_revision});
            if let Some(v) = automatic {
                input["automatic"] = json!(v);
            }
            if let Some(v) = summaries {
                input["summaries"] = json!(v);
            }
            if let Some(v) = channel {
                input["channel"] = json!(v);
            }
            m.policy(&application, &input)
        }
    }
}
