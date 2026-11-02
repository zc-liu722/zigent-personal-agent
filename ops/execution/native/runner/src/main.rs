//! Zigent's narrow process transport. Container policy and durable sessions live
//! in the worker; this executable owns one command and its byte streams only.
use std::{collections::HashMap, io::{self, Write}, path::PathBuf, sync::{Arc, Mutex}, time::Duration};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{io::{AsyncBufReadExt, BufReader}, sync::mpsc};
use zigent_terminal::{ChildFds, ProcessHandle, ProcessSignal, SpawnedProcess, TerminalSize};

fn emit(value: Value) {
    // A single write lock prevents output frames and replies from interleaving.
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if serde_json::to_writer(&mut output, &value).is_err()
        || output.write_all(b"\n").is_err() || output.flush().is_err() {
        std::process::exit(1);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    command: Vec<String>,
    cwd: PathBuf,
    tty: bool,
    #[serde(rename = "timeoutMs")]
    timeout_ms: u64,
    #[serde(default)]
    env: HashMap<String, String>,
}

async fn forward(mut receiver: mpsc::Receiver<Vec<u8>>) {
    while let Some(bytes) = receiver.recv().await {
        emit(json!({"event":"output", "data":STANDARD.encode(bytes)}));
    }
}

async fn start(value: Value, id: Value, active: Arc<Mutex<Option<Arc<ProcessHandle>>>>) -> Result<tokio::task::JoinHandle<()>> {
    let request: Start = serde_json::from_value(value)?;
    if request.command.is_empty() || !(1000..=86_400_000).contains(&request.timeout_ms) {
        bail!("Invalid command or timeout");
    }
    #[cfg(windows)]
    require_standard_account()?;
    let (program, args) = request.command.split_first().unwrap();
    let environment = request.env;
    let SpawnedProcess { session, stdout_rx, stderr_rx, mut exit_rx } = if request.tty {
        zigent_terminal::spawn_pty_process(program, args, &request.cwd, &environment, &None,
            TerminalSize::default(), ChildFds::Attached(&[])).await?
    } else {
        zigent_terminal::spawn_pipe_process(program, args, &request.cwd, &environment, &None, &[]).await?
    };
    let session = Arc::new(session);
    *active.lock().unwrap() = Some(session.clone());
    Ok(tokio::spawn(async move {
        let out = tokio::spawn(forward(stdout_rx));
        let err = tokio::spawn(forward(stderr_rx));
        let (code, timed_out) = tokio::select! {
            result = &mut exit_rx => (result.unwrap_or(-1), false),
            _ = tokio::time::sleep(Duration::from_millis(request.timeout_ms)) => {
                session.request_terminate();
                (exit_rx.await.unwrap_or(-1), true)
            }
        };
        #[cfg(windows)]
        {
            // Background execution retains its root. Once it exits, stop its
            // descendants and explicitly close ConPTY for Windows 10 EOF.
            session.request_terminate();
            session.close_pseudoconsole_after_exit().await;
        }
        // Descendants may retain output fds after their shell exits. Give final
        // output a bounded drain, then kill the owned group. The Windows worker
        // additionally confirms its named Job is empty before saving files.
        let drain = async { let _ = out.await; let _ = err.await; };
        let mut drain = Box::pin(drain);
        if tokio::time::timeout(Duration::from_millis(500), &mut drain).await.is_err() {
            session.request_terminate();
            if tokio::time::timeout(Duration::from_secs(2), &mut drain).await.is_err() {
                session.terminate();
                drain.await;
            }
        }
        *active.lock().unwrap() = None;
        emit(json!({"id":id,"result":{"exitCode":code,"timedOut":timed_out}}));
    }))
}

async fn serve() -> Result<()> {
    let active: Arc<Mutex<Option<Arc<ProcessHandle>>>> = Arc::new(Mutex::new(None));
    let mut task = None;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        // A process transport has no session resumption/replay policy of its own.
        // EOF always cleans up; the durable worker decides whether a job is lost.
        let line = tokio::select! {
            value = lines.next_line() => value?,
            _ = tokio::signal::ctrl_c() => None,
            _ = terminate_signal() => None,
        };
        let Some(line) = line else { break };
        if line.len() > 2 * 1024 * 1024 { bail!("Input frame too large"); }
        let value: Value = serde_json::from_str(&line)?;
        let id = value["id"].clone();
        let result: Result<()> = async {
            match value["op"].as_str() {
                Some("start") if task.is_none() => {
                    task = Some(start(value["params"].clone(), id.clone(), active.clone()).await?);
                    return Ok(()); // final reply follows drained output
                }
                Some("write" | "interrupt" | "terminate" | "close_stdin") => {
                    let session = active.lock().unwrap().clone()
                        .ok_or_else(|| anyhow::anyhow!("No active process"))?;
                    match value["op"].as_str().unwrap() {
                        "write" => {
                            let bytes = STANDARD.decode(value["params"]["data"].as_str().unwrap_or(""))?;
                            session.writer_sender().send(bytes).await?;
                        }
                        "interrupt" => session.signal(ProcessSignal::Interrupt)?,
                        "terminate" => session.request_terminate(),
                        _ => session.close_stdin(),
                    }
                }
                _ => bail!("Unsupported operation or command already started"),
            }
            emit(json!({"id":id,"result":{}}));
            Ok(())
        }.await;
        if let Err(error) = result { emit(json!({"id":id,"error":{"message":error.to_string()}})); }
    }
    if let Some(session) = active.lock().unwrap().as_ref() { session.request_terminate(); }
    if let Some(task) = task { let _ = task.await; }
    Ok(())
}

async fn terminate_signal() {
    #[cfg(unix)]
    { tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap().recv().await; }
    #[cfg(not(unix))]
    std::future::pending::<()>().await;
}

fn main() -> Result<()> {
    #[cfg(target_os = "linux")]
    zigent_terminal::init_spawn_helper(std::env::args_os());
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("zigent-execution {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?.block_on(serve())
}

#[cfg(windows)]
fn require_standard_account() -> Result<()> {
    use winapi::um::{processthreadsapi::{GetCurrentProcess,OpenProcessToken},
        securitybaseapi::GetTokenInformation,handleapi::CloseHandle,
        winnt::{TOKEN_QUERY,TOKEN_ELEVATION,TokenElevation}};
    let mut token=std::ptr::null_mut();
    unsafe {
        if OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&mut token)==0 { bail!("Cannot inspect execution identity"); }
        let mut elevation:TOKEN_ELEVATION=std::mem::zeroed();let mut length=0;
        let result=GetTokenInformation(token,TokenElevation,(&mut elevation as *mut TOKEN_ELEVATION).cast(),std::mem::size_of::<TOKEN_ELEVATION>() as u32,&mut length);
        CloseHandle(token);
        if result==0 || elevation.TokenIsElevated!=0 { bail!("Model commands require a non-elevated execution account"); }
    }
    Ok(())
}
