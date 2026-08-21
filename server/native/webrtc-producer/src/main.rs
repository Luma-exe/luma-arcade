// Custom WebRTC producer for LumaArcade, replacing gst-plugins-rs's `webrtcsink`.
//
// `webrtcsink` builds a temporary internal sub-pipeline per candidate codec to
// auto-discover which encoder to use before it ever connects to the signaller.
// On this machine those discovery `appsrc` elements were observed (via
// GST_DEBUG) to hang permanently "flushing" specifically when fed real
// d3d11screencapturesrc frames, while the identical config connects instantly
// with videotestsrc. This binary sidesteps that discovery step by driving
// GStreamer's lower-level `webrtcbin` element directly, handling SDP
// offer/answer and ICE exchange by hand against the app's existing signalling
// server (server/src/signalling/server.ts), which speaks the same JSON
// protocol webrtcsink used (setPeerStatus / startSession / peer / endSession).
//
// Desktop capture itself is *not* done in-process: d3d11screencapturesrc's
// desktop-duplication acquisition was observed to fail reliably and
// reproducibly with E_ACCESSDENIED when driven from this binary specifically
// (same pipeline, same machine, same moment) while succeeding every time
// under a plain `gst-launch-1.0` invocation -- extensive isolation (bus
// pumping, a GLib main loop, matching gst-launch's PAUSED-then-PLAYING
// sequencing, DPI awareness, pipeline-rebuild retries) never found the actual
// cause. Rather than keep chasing it, capture+encode is delegated to a real
// gst-launch-1.0 child process (proven reliable), which streams RTP to this
// process over localhost UDP; this process only ever runs `udpsrc` and
// `webrtcbin`, never touching D3D11 itself.

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_sdp;
use gstreamer_webrtc as gst_webrtc;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

struct Args {
    signalling_uri: String,
    window_handle: Option<String>,
    framerate: u32,
    bitrate_kbps: u32,
    stun_server: Option<String>,
    turn_server: Option<String>,
    udp_port: u16,
    gst_launch_path: Option<String>,
}

fn parse_args() -> Result<Args> {
    let mut signalling_uri = None;
    let mut window_handle = None;
    let mut framerate = 60u32;
    let mut bitrate_kbps = 8000u32;
    let mut stun_server = None;
    let mut turn_server = None;
    let mut udp_port = 47000u16;
    let mut gst_launch_path = None;

    let mut argv = std::env::args().skip(1);
    while let Some(flag) = argv.next() {
        let value = argv.next();
        match (flag.as_str(), value) {
            ("--signalling-uri", Some(v)) => signalling_uri = Some(v),
            ("--window-handle", Some(v)) => window_handle = Some(v),
            ("--framerate", Some(v)) => framerate = v.parse().unwrap_or(60),
            ("--bitrate-kbps", Some(v)) => bitrate_kbps = v.parse().unwrap_or(8000),
            ("--stun-server", Some(v)) => stun_server = Some(v),
            ("--turn-server", Some(v)) => turn_server = Some(v),
            ("--udp-port", Some(v)) => udp_port = v.parse().unwrap_or(47000),
            ("--gst-launch-path", Some(v)) => gst_launch_path = Some(v),
            _ => {}
        }
    }

    Ok(Args {
        signalling_uri: signalling_uri.context("--signalling-uri is required")?,
        window_handle,
        framerate,
        bitrate_kbps,
        stun_server,
        turn_server,
        udp_port,
        gst_launch_path,
    })
}

fn have_element(name: &str) -> bool {
    gst::ElementFactory::find(name).is_some()
}

fn resolve_gst_launch(args: &Args) -> String {
    if let Some(p) = &args.gst_launch_path {
        return p.clone();
    }
    let candidates = [
        r"C:\gstreamer\1.0\msvc_x86_64\bin\gst-launch-1.0.exe",
        r"C:\Program Files\gstreamer\1.0\msvc_x86_64\bin\gst-launch-1.0.exe",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = format!(r"{local}\Programs\gstreamer\1.0\msvc_x86_64\bin\gst-launch-1.0.exe");
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "gst-launch-1.0".to_string()
}

/// Spawns a `gst-launch-1.0` child process that captures the desktop (or a
/// single window), encodes it to H.264, and streams RTP to this process over
/// localhost UDP. See the module-level comment for why this runs out of
/// process rather than as part of the webrtcbin pipeline below.
fn spawn_capture_process(args: &Args) -> Result<Child> {
    let mut src = "d3d11screencapturesrc show-cursor=true".to_string();
    if let Some(hwnd) = &args.window_handle {
        src.push_str(&format!(" window-handle={hwnd}"));
    }

    let use_hardware = std::env::args().any(|a| a == "--hardware-encoder");
    let encoder = if use_hardware && have_element("nvh264enc") {
        eprintln!("[webrtc-producer] capture: using nvh264enc");
        format!("nvh264enc bitrate={}", args.bitrate_kbps)
    } else {
        eprintln!("[webrtc-producer] capture: using x264enc (software)");
        format!(
            "x264enc tune=zerolatency speed-preset=ultrafast bitrate={} key-int-max={}",
            args.bitrate_kbps,
            args.framerate * 2
        )
    };

    // gst-launch-1.0 tokenizes/rejoins its own argv elements (that's why the
    // original TypeScript pipeline builder always passed an array of tokens,
    // never one joined string) -- passing this as a single argument instead
    // routes it through gst_parse_launch's internal string parser instead,
    // which needs shell-style quoting around things like
    // "video/x-raw(memory:D3D11Memory)" that it otherwise chokes on with
    // "syntax error". Splitting on whitespace and passing each piece as its
    // own argv element sidesteps that entirely.
    // videoconvert's auto-negotiated output format was observed to
    // nondeterministically land on Y444 instead of I420 depending on timing
    // -- x264enc silently produces zero output when fed Y444 (no error on
    // the bus, just a permanently stalled src pad; "x264 [error]: baseline
    // profile doesn't support 4:4:4" is the only clue, and it's easy to
    // miss). Pinning the format explicitly avoids the whole ambiguity.
    let pipeline_desc = format!(
        "{src} ! video/x-raw(memory:D3D11Memory),framerate={fr}/1 ! d3d11download ! videoconvert \
         ! video/x-raw,format=I420 \
         ! queue \
         ! {encoder} ! h264parse config-interval=-1 \
         ! rtph264pay pt=96 config-interval=-1 mtu=1200 \
         ! udpsink host=127.0.0.1 port={port} sync=false async=false",
        src = src,
        fr = args.framerate,
        encoder = encoder,
        port = args.udp_port,
    );
    let tokens: Vec<&str> = pipeline_desc.split_whitespace().collect();

    let gst_launch = resolve_gst_launch(args);
    eprintln!("[webrtc-producer] spawning capture: {gst_launch} -v {pipeline_desc}");

    let mut child = Command::new(&gst_launch)
        .arg("-v")
        .args(&tokens)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn {gst_launch}"))?;

    for (tag, stream) in [
        ("capture-out", child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)),
        ("capture-err", child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)),
    ] {
        if let Some(stream) = stream {
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    eprintln!("[webrtc-producer:{tag}] {line}");
                }
            });
        }
    }

    Ok(child)
}

fn build_receive_pipeline(args: &Args) -> Result<gst::Pipeline> {
    let desc = format!(
        "udpsrc port={port} caps=\"application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000\" \
         ! rtpjitterbuffer latency=100 \
         ! webrtcbin name=sendrecv bundle-policy=max-bundle",
        port = args.udp_port,
    );

    eprintln!("[webrtc-producer] receive pipeline: {desc}");
    let pipeline = gst::parse::launch(&desc)?
        .downcast::<gst::Pipeline>()
        .map_err(|_| anyhow!("parsed pipeline was not a gst::Pipeline"))?;

    let webrtcbin = pipeline
        .by_name("sendrecv")
        .context("webrtcbin element 'sendrecv' not found after parse")?;

    if let Some(stun) = &args.stun_server {
        webrtcbin.set_property("stun-server", stun);
    }
    if let Some(turn) = &args.turn_server {
        let added: bool = webrtcbin.emit_by_name("add-turn-server", &[turn]);
        if !added {
            eprintln!("[webrtc-producer] warning: webrtcbin rejected turn-server value");
        }
    }

    Ok(pipeline)
}

/// Signalling state shared between the GStreamer signal callbacks (fired on
/// GStreamer's own threads) and the tokio websocket tasks. The offer and any
/// ICE candidates webrtcbin produces can arrive before the browser's
/// `startSession` request reaches us (the producer connects and registers
/// well before a consumer necessarily exists) -- both sides are buffered here
/// and only flushed to the signalling server once both the session id and the
/// local description are known.
#[derive(Default)]
struct PendingSession {
    session_id: Option<String>,
    local_sdp: Option<String>,
    pending_ice: Vec<(u32, String)>,
    sent_offer: bool,
}

struct Shared {
    pending: Mutex<PendingSession>,
    out_tx: mpsc::UnboundedSender<Value>,
}

impl Shared {
    fn maybe_flush(&self) {
        let mut pending = self.pending.lock().unwrap();
        if pending.sent_offer {
            return;
        }
        let (Some(session_id), Some(sdp)) = (pending.session_id.clone(), pending.local_sdp.clone())
        else {
            return;
        };
        pending.sent_offer = true;

        let _ = self.out_tx.send(json!({
            "type": "peer",
            "sessionId": session_id,
            "sdp": { "type": "offer", "sdp": sdp },
        }));

        for (mline, candidate) in pending.pending_ice.drain(..) {
            let _ = self.out_tx.send(json!({
                "type": "peer",
                "sessionId": session_id,
                "ice": { "candidate": candidate, "sdpMLineIndex": mline },
            }));
        }
    }

    fn on_session_started(&self, session_id: String) {
        self.pending.lock().unwrap().session_id = Some(session_id);
        self.maybe_flush();
    }

    fn on_local_sdp(&self, sdp: String) {
        self.pending.lock().unwrap().local_sdp = Some(sdp);
        self.maybe_flush();
    }

    fn on_ice_candidate(&self, mline: u32, candidate: String) {
        let mut pending = self.pending.lock().unwrap();
        if pending.sent_offer {
            let session_id = pending.session_id.clone().unwrap();
            drop(pending);
            let _ = self.out_tx.send(json!({
                "type": "peer",
                "sessionId": session_id,
                "ice": { "candidate": candidate, "sdpMLineIndex": mline },
            }));
        } else {
            pending.pending_ice.push((mline, candidate));
        }
    }
}

fn wire_webrtcbin(webrtcbin: &gst::Element, shared: Arc<Shared>) {
    let shared_offer = shared.clone();
    let webrtcbin_for_offer = webrtcbin.clone();
    webrtcbin.connect("on-negotiation-needed", false, move |_| {
        let webrtcbin = webrtcbin_for_offer.clone();
        let shared = shared_offer.clone();
        let webrtcbin_inner = webrtcbin.clone();
        let promise = gst::Promise::with_change_func(move |reply| {
            let webrtcbin = webrtcbin_inner;
            let reply = match reply {
                Ok(Some(r)) => r,
                _ => {
                    eprintln!("[webrtc-producer] create-offer failed: {reply:?}");
                    return;
                }
            };
            let offer = match reply
                .value("offer")
                .ok()
                .and_then(|v| v.get::<gst_webrtc::WebRTCSessionDescription>().ok())
            {
                Some(o) => o,
                None => {
                    eprintln!("[webrtc-producer] no offer in create-offer reply");
                    return;
                }
            };
            let sdp_text = offer.sdp().as_text().unwrap_or_default();
            webrtcbin.emit_by_name::<()>("set-local-description", &[&offer, &None::<gst::Promise>]);
            shared.on_local_sdp(sdp_text);
        });
        webrtcbin.emit_by_name::<()>("create-offer", &[&None::<gst::Structure>, &promise]);
        None
    });

    let shared_ice = shared.clone();
    webrtcbin.connect("on-ice-candidate", false, move |values| {
        let mline = values[1].get::<u32>().unwrap_or(0);
        let candidate = values[2].get::<String>().unwrap_or_default();
        shared_ice.on_ice_candidate(mline, candidate);
        None
    });
}

fn watch_bus(pipeline: &gst::Pipeline) -> Result<()> {
    let bus = pipeline.bus().context("pipeline has no bus")?;
    let bus_pipeline = pipeline.clone();
    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            use gst::MessageView;
            match msg.view() {
                MessageView::Error(err) => {
                    eprintln!(
                        "[webrtc-producer] pipeline error from {:?}: {} ({:?})",
                        err.src().map(|s| s.path_string()),
                        err.error(),
                        err.debug()
                    );
                }
                MessageView::Warning(warn) => {
                    eprintln!(
                        "[webrtc-producer] pipeline warning: {} ({:?})",
                        warn.error(),
                        warn.debug()
                    );
                }
                MessageView::Eos(_) => break,
                _ => {}
            }
            if bus_pipeline.current_state() == gst::State::Null {
                break;
            }
        }
    });
    Ok(())
}

/// Builds the receive pipeline (udpsrc -> webrtcbin) and waits for the first
/// RTP packet to actually arrive from the capture child process. The capture
/// child's own d3d11screencapturesrc was, just like the in-process attempt
/// this replaced, observed to occasionally come up wedged (0% CPU, no data,
/// sometimes with and sometimes without the "Access is denied" warnings
/// actually appearing in its log) -- since simply waiting longer never
/// recovered it in testing, each retry here kills and respawns the capture
/// child too, not just this process's own receive pipeline.
fn acquire_working_pipeline(args: &Args, capture_child: &mut Child) -> Result<gst::Pipeline> {
    const MAX_ATTEMPTS: u32 = 6;
    const ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            let _ = capture_child.kill();
            let _ = capture_child.wait();
            *capture_child = spawn_capture_process(args)?;
            #[cfg(windows)]
            kill_child_when_we_die(capture_child);
        }

        let pipeline = build_receive_pipeline(args)?;
        watch_bus(&pipeline)?;

        let udpsrc = pipeline
            .iterate_elements()
            .into_iter()
            .filter_map(|e| e.ok())
            .find(|e| e.factory().map(|f| f.name() == "udpsrc").unwrap_or(false))
            .context("udpsrc element missing")?;
        let (buf_tx, buf_rx) = std::sync::mpsc::channel::<()>();
        let src_pad = udpsrc.static_pad("src").context("udpsrc has no src pad")?;
        let probe_id = src_pad.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            let _ = buf_tx.send(());
            gst::PadProbeReturn::Remove
        });

        pipeline.set_state(gst::State::Playing)?;

        match buf_rx.recv_timeout(ATTEMPT_TIMEOUT) {
            Ok(()) => {
                eprintln!("[webrtc-producer] RTP flowing from capture process (attempt {attempt})");
                return Ok(pipeline);
            }
            Err(_) => {
                eprintln!(
                    "[webrtc-producer] no RTP received within {:?}, restarting capture and retrying (attempt {attempt}/{MAX_ATTEMPTS})",
                    ATTEMPT_TIMEOUT
                );
                if let Some(id) = probe_id {
                    src_pad.remove_probe(id);
                }
                let _ = pipeline.set_state(gst::State::Null);
            }
        }
    }

    Err(anyhow!(
        "no RTP received from capture process after {MAX_ATTEMPTS} attempts"
    ))
}

async fn run(args: Args) -> Result<()> {
    gst::init()?;

    // webrtcbin schedules its "on-negotiation-needed" signal (and other
    // internal bookkeeping) via a glib idle callback on the default main
    // context, coalescing multiple pad additions into one negotiation. This
    // process otherwise only runs a tokio runtime -- with no GLib main loop
    // ever iterating the default context, that idle callback was observed to
    // simply never fire, silently: no error, no signal, no offer. gst-launch-
    // 1.0 works because it always runs a GMainLoop internally.
    std::thread::spawn(|| {
        glib::MainLoop::new(None, false).run();
    });

    let mut capture_child = spawn_capture_process(&args)?;
    #[cfg(windows)]
    kill_child_when_we_die(&capture_child);
    let pipeline = acquire_working_pipeline(&args, &mut capture_child);
    let pipeline = match pipeline {
        Ok(p) => p,
        Err(e) => {
            let _ = capture_child.kill();
            return Err(e);
        }
    };
    let webrtcbin = pipeline
        .by_name("sendrecv")
        .context("webrtcbin element missing")?;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    let shared = Arc::new(Shared {
        pending: Mutex::new(PendingSession::default()),
        out_tx: out_tx.clone(),
    });
    wire_webrtcbin(&webrtcbin, shared.clone());

    let (ws_stream, _) = tokio_tungstenite::connect_async(&args.signalling_uri)
        .await
        .context("failed to connect to signalling server")?;
    let (mut ws_write, mut ws_read) = ws_stream.split();

    // Forward outgoing signalling messages (produced from GStreamer callback
    // threads via `out_tx`) onto the websocket.
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if ws_write.send(Message::Text(msg.to_string())).await.is_err() {
                break;
            }
        }
    });

    out_tx
        .send(json!({ "type": "setPeerStatus", "roles": ["producer"] }))
        .ok();

    while let Some(msg) = ws_read.next().await {
        let msg = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };
        let parsed: Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match parsed.get("type").and_then(Value::as_str) {
            Some("welcome") => {
                eprintln!("[webrtc-producer] registered with signalling server");
            }
            Some("startSession") => {
                if let Some(session_id) = parsed.get("sessionId").and_then(Value::as_str) {
                    eprintln!("[webrtc-producer] starting session {session_id}");
                    shared.on_session_started(session_id.to_string());
                }
            }
            Some("peer") => {
                if let Some(sdp) = parsed.get("sdp") {
                    if sdp.get("type").and_then(Value::as_str) == Some("answer") {
                        if let Some(sdp_text) = sdp.get("sdp").and_then(Value::as_str) {
                            match gstreamer_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes()) {
                                Ok(sdp_msg) => {
                                    let answer = gst_webrtc::WebRTCSessionDescription::new(
                                        gst_webrtc::WebRTCSDPType::Answer,
                                        sdp_msg,
                                    );
                                    webrtcbin.emit_by_name::<()>(
                                        "set-remote-description",
                                        &[&answer, &None::<gst::Promise>],
                                    );
                                }
                                Err(err) => {
                                    eprintln!("[webrtc-producer] failed to parse remote SDP: {err}");
                                }
                            }
                        }
                    }
                } else if let Some(ice) = parsed.get("ice") {
                    let candidate = ice.get("candidate").and_then(Value::as_str).unwrap_or("");
                    let mline = ice.get("sdpMLineIndex").and_then(Value::as_u64).unwrap_or(0) as u32;
                    webrtcbin.emit_by_name::<()>("add-ice-candidate", &[&mline, &candidate]);
                }
            }
            Some("endSession") => {
                eprintln!("[webrtc-producer] session ended");
            }
            Some("error") => {
                eprintln!("[webrtc-producer] signalling error: {parsed}");
            }
            _ => {}
        }
    }

    drop(out_tx);
    let _ = writer.await;
    pipeline.set_state(gst::State::Null)?;
    Ok(())
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SetProcessDpiAwarenessContext(value: isize) -> i32;
}

// The capture child process (gst-launch-1.0, holding the D3D11 desktop
// duplication handle) must not outlive this process: Node manages this
// binary's lifecycle by TerminateProcess, which -- unlike a normal exit --
// does not run any Drop code here to kill the child, and Windows does not
// kill child processes automatically when their parent dies. An orphaned
// capture child was observed firsthand during development to permanently
// hold the desktop duplication handle, blocking every subsequent stream
// start until manually killed. A Job Object with KILL_ON_JOB_CLOSE ties the
// child's lifetime to this process's at the OS level regardless of how this
// process exits.
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attrs: *const std::ffi::c_void, name: *const u16) -> isize;
    fn SetInformationJobObject(
        job: isize,
        info_class: u32,
        info: *const std::ffi::c_void,
        len: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(windows)]
#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[cfg(windows)]
#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
fn kill_child_when_we_die(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job == 0 {
            eprintln!("[webrtc-producer] warning: CreateJobObjectW failed, capture process may outlive this one");
            return;
        }
        let mut info: JobObjectExtendedLimitInformation = std::mem::zeroed();
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
        );
        if ok == 0 {
            eprintln!("[webrtc-producer] warning: SetInformationJobObject failed");
            return;
        }
        let process_handle = child.as_raw_handle() as isize;
        if AssignProcessToJobObject(job, process_handle) == 0 {
            eprintln!("[webrtc-producer] warning: AssignProcessToJobObject failed");
        }
    }
}

fn main() -> Result<()> {
    // A plain `cargo build` binary carries no application manifest, so
    // Windows treats it as DPI-unaware by default -- unlike gst-launch-1.0.exe
    // (which ships with GStreamer's own manifest declaring DPI awareness).
    // d3d11screencapturesrc's desktop-duplication acquisition was observed to
    // fail with E_ACCESSDENIED reliably under this binary while gst-launch-1.0
    // with the identical pipeline succeeded every time; DPI-unaware processes
    // are known to be restricted from some desktop capture/composition APIs,
    // so this is set explicitly as a cheap, likely fix before assuming
    // anything more exotic is going on.
    #[cfg(windows)]
    unsafe {
        const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: isize = -4;
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let args = parse_args()?;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run(args))
}
