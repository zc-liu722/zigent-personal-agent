//! Zigent pipe adapter. Reuses the pinned Codex Windows command/environment and
//! process-attribute helpers; Job ownership and stdio inheritance are atomic.
use std::{collections::HashMap, ffi::OsStr, io::{self,Read,Write}, path::Path,
    os::windows::io::{AsRawHandle,FromRawHandle}, sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}}};
use anyhow::{Result,bail};
use filedescriptor::{OwnedHandle,Pipe};
use portable_pty::CommandBuilder;
use tokio::sync::{mpsc,oneshot};
use winapi::um::{handleapi::SetHandleInformation,processthreadsapi::{CreateProcessW,PROCESS_INFORMATION,GetExitCodeProcess},synchapi::WaitForSingleObject,
    winbase::{STARTUPINFOEXW,CREATE_NO_WINDOW,CREATE_UNICODE_ENVIRONMENT,EXTENDED_STARTUPINFO_PRESENT,INFINITE,STARTF_USESTDHANDLES},winnt::HANDLE};
use super::{JobObject,procthreadattr::ProcThreadAttributeList,psuedocon::{build_cmdline,build_environment_block}};
use crate::process::{ChildTerminator,ProcessHandle,ProcessSignal,SpawnedProcess};

struct Terminator(Arc<JobObject>);
impl ChildTerminator for Terminator {
    fn signal(&mut self,_signal:ProcessSignal)->io::Result<()> {self.0.terminate()}
    fn kill(&mut self)->io::Result<()> {self.0.terminate()}
}

pub async fn spawn(program:&OsStr,args:&[String],cwd:&Path,env:&HashMap<String,String>,closed:bool)->Result<SpawnedProcess> {
    use std::os::windows::ffi::OsStrExt;
    let job=Arc::new(JobObject::create_without_breakaway()?);
    let mut cmd=CommandBuilder::new(program);
    cmd.args(args);cmd.cwd(cwd);cmd.env_clear();
    for (key,value) in env {cmd.env(key,value);}
    let (mut exe,mut command)=build_cmdline(&cmd)?;
    let mut environment=build_environment_block(&cmd);
    let cwd:Vec<u16>=cwd.as_os_str().encode_wide().chain(Some(0)).collect();
    let stdin=Pipe::new()?;let stdout=Pipe::new()?;let stderr=Pipe::new()?;
    let handles=vec![stdin.read.as_raw_handle() as HANDLE,stdout.write.as_raw_handle() as HANDLE,stderr.write.as_raw_handle() as HANDLE];
    for handle in &handles {
        if unsafe{SetHandleInformation(*handle,1,1)}==0 {return Err(io::Error::last_os_error().into());}
    }
    let mut attributes=ProcThreadAttributeList::with_capacity(2)?;
    attributes.set_job(job.as_raw_handle().cast())?;attributes.set_handles(handles.clone())?;
    let mut si:STARTUPINFOEXW=unsafe{std::mem::zeroed()};
    si.StartupInfo.cb=std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput=handles[0];si.StartupInfo.hStdOutput=handles[1];si.StartupInfo.hStdError=handles[2];
    si.lpAttributeList=attributes.as_mut_ptr();
    let mut pi:PROCESS_INFORMATION=unsafe{std::mem::zeroed()};
    let success=unsafe{CreateProcessW(exe.as_mut_ptr(),command.as_mut_ptr(),std::ptr::null_mut(),std::ptr::null_mut(),1,
        EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,
        environment.as_mut_ptr().cast(),cwd.as_ptr(),&mut si.StartupInfo,&mut pi)};
    if success==0 {bail!("Windows pipe launch failed: {}",io::Error::last_os_error());}
    let process=unsafe{OwnedHandle::from_raw_handle(pi.hProcess.cast())};
    let thread=unsafe{OwnedHandle::from_raw_handle(pi.hThread.cast())};drop(thread);
    drop(stdin.read);drop(stdout.write);drop(stderr.write);
    let (writer_tx,mut writer_rx)=mpsc::channel::<Vec<u8>>(128);
    let (stdout_tx,stdout_rx)=mpsc::channel::<Vec<u8>>(128);
    let (stderr_tx,stderr_rx)=mpsc::channel::<Vec<u8>>(128);
    let reader=|mut pipe:filedescriptor::FileDescriptor,tx:mpsc::Sender<Vec<u8>>|tokio::task::spawn_blocking(move||{
        let mut buffer=[0u8;8192];loop {match pipe.read(&mut buffer){Ok(0)=>break,Ok(n)=>{if tx.blocking_send(buffer[..n].to_vec()).is_err(){break}},Err(e) if e.kind()==io::ErrorKind::Interrupted=>continue,Err(_)=>break}}
    });
    let out=reader(stdout.read,stdout_tx);let err=reader(stderr.read,stderr_tx);
    let writer=tokio::task::spawn_blocking(move||{
        let mut pipe=stdin.write;if closed{return}
        while let Some(bytes)=writer_rx.blocking_recv(){if pipe.write_all(&bytes).and_then(|_|pipe.flush()).is_err(){break}}
    });
    let (exit_tx,exit_rx)=oneshot::channel();
    let exited=Arc::new(AtomicBool::new(false));let code=Arc::new(Mutex::new(None));
    let seen=exited.clone();let saved=code.clone();
    let wait=tokio::task::spawn_blocking(move||{
        unsafe{WaitForSingleObject(process.as_raw_handle().cast(),INFINITE)};
        let mut value=1;unsafe{GetExitCodeProcess(process.as_raw_handle().cast(),&mut value)};
        seen.store(true,Ordering::SeqCst);*saved.lock().unwrap()=Some(value as i32);let _=exit_tx.send(value as i32);
    });
    let session=ProcessHandle::new(writer_tx,Box::new(Terminator(job)),Some(out),Some(err),writer,wait,exited,code,None,None);
    Ok(SpawnedProcess{session,stdout_rx,stderr_rx,exit_rx})
}
