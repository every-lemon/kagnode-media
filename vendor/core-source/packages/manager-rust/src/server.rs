use crate::{Manager, atomic, file_lock, now};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
    },
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

fn peer(stream: &UnixStream) -> Result<u32> {
    let mut credential = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    ensure!(
        unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credential as *mut libc::ucred).cast(),
                &mut len,
            )
        } == 0,
        "Cannot verify local Core peer"
    );
    Ok(credential.uid)
}
fn response(stream: &mut UnixStream, status: u16, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    let mut status = status;
    if bytes.len() > 72 * 1024 {
        bytes = serde_json::to_vec(&json!({"error":"Core response exceeded its bound"}))?;
        status = 500;
    }
    write!(
        stream,
        "HTTP/1.0 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}
fn request(stream: &mut UnixStream) -> Result<Value> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.by_ref().take(8193).read_line(&mut line)?;
    ensure!(
        line == "POST / HTTP/1.0\r\n" || line == "POST / HTTP/1.1\r\n",
        "Invalid Core manager request line"
    );
    let mut total = line.len();
    let mut length = None;
    loop {
        line.clear();
        reader
            .by_ref()
            .take((8193 - total) as u64)
            .read_line(&mut line)?;
        total += line.len();
        ensure!(
            total <= 8192 && !line.is_empty(),
            "Invalid Core request headers"
        );
        if line == "\r\n" {
            break;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("Malformed Core header"))?;
        ensure!(
            !name.eq_ignore_ascii_case("transfer-encoding"),
            "Transfer encoding is not supported"
        );
        if name.eq_ignore_ascii_case("content-length") {
            ensure!(length.is_none(), "Repeated content length");
            length = Some(value.trim().parse::<usize>()?);
        }
    }
    let length = length.ok_or_else(|| anyhow::anyhow!("Missing content length"))?;
    ensure!(
        (1..=4096).contains(&length),
        "Core request exceeds its bound"
    );
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}
struct Active(Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
pub fn serve(manager: Manager) -> Result<()> {
    manager.ensure()?;
    let _daemon = file_lock(&manager.root.join(".daemon.lock"))?;
    let stop = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, stop.clone())?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, stop.clone())?;
    let manager = Arc::new(manager);
    let active = Arc::new(AtomicUsize::new(0));
    let mut servers = Vec::<(String, PathBuf, UnixListener)>::new();
    let mut last_scan = 0;
    while !stop.load(Ordering::Relaxed) {
        if now() - last_scan >= 5 {
            last_scan = now();
            let mut names = BTreeSet::new();
            for entry in std::fs::read_dir(manager.root.join("apps"))?.take(256) {
                let path = entry?.path();
                if !path.join("state.json").is_file() {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let state = match manager.state(name) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                names.insert(name.to_owned());
                if !servers.iter().any(|(id, _, _)| id == name) {
                    let socket = manager.root.join("run").join(format!("{name}.sock"));
                    ensure!(!socket.is_symlink(), "Unsafe Core socket link");
                    if socket.exists() {
                        ensure!(
                            UnixStream::connect(&socket).is_err(),
                            "Another manager owns the application socket"
                        );
                        std::fs::remove_file(&socket)?;
                    }
                    let listener = UnixListener::bind(&socket)?;
                    listener.set_nonblocking(true)?;
                    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
                    let c = std::ffi::CString::new(socket.as_os_str().as_encoded_bytes())?;
                    ensure!(
                        unsafe {
                            libc::chown(
                                c.as_ptr(),
                                state["uid"].as_u64().unwrap() as u32,
                                state["gid"].as_u64().unwrap() as u32,
                            )
                        } == 0,
                        "Cannot assign Core application socket"
                    );
                    servers.push((name.into(), socket, listener));
                }
                if let Ok(_guard) = manager.lock() {
                    let _ = manager.recover(name);
                }
                let due = state["automatic"] == true
                    && now() - state["last_check"].as_i64().unwrap_or(0)
                        >= 6 * 3600 + state["check_jitter"].as_i64().unwrap_or(0);
                if due && active.load(Ordering::SeqCst) == 0 {
                    active.fetch_add(1, Ordering::SeqCst);
                    let m = manager.clone();
                    let n = name.to_owned();
                    let count = active.clone();
                    std::thread::spawn(move || {
                        let _active = Active(count);
                        if let Err(error) = m.apply(&n, None, true)
                            && let Ok(_guard) = m.lock()
                            && let Ok(mut s) = m.state(&n)
                        {
                            s["last_check"] = json!(now());
                            s["last_error"] = json!(error.to_string());
                            let _ = atomic(&m.app(&n).unwrap().join("state.json"), &s);
                        }
                    });
                }
            }
            servers.retain(|(name, path, _)| {
                if names.contains(name) {
                    true
                } else {
                    let _ = std::fs::remove_file(path);
                    false
                }
            });
        }
        for (name, _, listener) in &servers {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let state = manager.state(name)?;
                    let uid = peer(&stream)?;
                    if uid != 0 && Some(u64::from(uid)) != state["uid"].as_u64() {
                        let _ = response(
                            &mut stream,
                            403,
                            json!({"error":"This local process is not authorized"}),
                        );
                        continue;
                    }
                    if active.load(Ordering::SeqCst) >= 4 {
                        let _ = response(
                            &mut stream,
                            409,
                            json!({"error":"Core manager is busy; inspect status before retrying"}),
                        );
                        continue;
                    }
                    active.fetch_add(1, Ordering::SeqCst);
                    let count = active.clone();
                    let m = manager.clone();
                    let n = name.clone();
                    std::thread::spawn(move || {
                        let _active = Active(count);
                        let result = request(&mut stream).and_then(|body| m.dispatch(&n, body));
                        let (status, value) = match result {
                            Ok(value) => (200, value),
                            Err(error) => (
                                if error.to_string().contains("Another Core") {
                                    409
                                } else {
                                    400
                                },
                                json!({"error":error.to_string()}),
                            ),
                        };
                        let _ = response(&mut stream, status, value);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.into()),
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let end = std::time::Instant::now() + Duration::from_secs(100);
    while active.load(Ordering::SeqCst) > 0 && std::time::Instant::now() < end {
        std::thread::sleep(Duration::from_millis(100));
    }
    for (_, path, _) in servers {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_lengths_and_chunked_requests_are_rejected() {
        for header in [
            "Content-Length: 2\r\nContent-Length: 2\r\n",
            "Transfer-Encoding: chunked\r\nContent-Length: 2\r\n",
            "Content-Length: 999999\r\n",
        ] {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            let bytes = format!("POST / HTTP/1.0\r\n{header}\r\n{{}}");
            client.write_all(bytes.as_bytes()).unwrap();
            assert!(request(&mut server).is_err());
        }
    }
}
