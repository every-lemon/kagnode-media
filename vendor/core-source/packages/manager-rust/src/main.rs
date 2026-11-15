use clap::Parser;
#[derive(Parser)]
#[command(version, about = "KagNode signed local Core UI manager")]
struct Args {
    #[arg(long, default_value = "/srv/kagnode/core")]
    core_root: std::path::PathBuf,
    #[command(subcommand)]
    command: kagnode_core_manager::cli::Command,
}
fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let value = kagnode_core_manager::cli::run(args.core_root, args.command)?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
