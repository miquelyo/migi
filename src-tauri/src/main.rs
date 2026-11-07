// =====================================================================
//  migi: seluruh backend Rust ada di SATU file ini.
//  Bagian: 1) Musik  2) Lirik  3) Baterai/charger  4) Idle & maximize
//          5) Clipboard & jendela  6) Bluetooth  7) Tray & Pengaturan
//          8) Hover & click-through  9) Notifikasi  10) Perangkat BT
//          11) Volume  12) Brightness  13) main()
// =====================================================================
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use serde_json::Value;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use windows::core::{implement, IInspectable, Interface, PCWSTR};
use windows::Devices::Bluetooth::GenericAttributeProfile::{
    GattCharacteristicUuids, GattCommunicationStatus, GattServiceUuids,
};
use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice};
use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationUpdate, DeviceWatcher};
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProps,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStream};
use windows::UI::Notifications::Management::{
    UserNotificationListener, UserNotificationListenerAccessStatus,
};
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds, UserNotification};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT, SIZE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::Media::Audio::Endpoints::{
    IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
};
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
    IMMNotificationClient_Impl, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA, DEVICE_STATE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemInformation::{GetSystemTimeAsFileTime, GetTickCount};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
use windows::Win32::UI::Shell::{
    IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
    SIIGBF_ICONONLY,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindow,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, ShowWindow,
    GW_HWNDNEXT, SM_CXSCREEN, SM_CYSCREEN, SW_HIDE,
};

/// Zona hover aktif (piksel fisik), diisi lewat `set_hot`.
static HOT_W: AtomicU32 = AtomicU32::new(0);
static HOT_H: AtomicU32 = AtomicU32::new(0);

/// Sembunyikan OSD volume/brightness bawaan Windows (diganti OSD di notch).
/// Eksperimental: jika taskbar/flyout Windows jadi aneh, ubah ke `false`.
const HIDE_NATIVE_OSD: bool = true;
/// Sampai kapan (epoch ms) jendela OSD Windows diburu & disembunyikan.
static OSD_UNTIL: AtomicU64 = AtomicU64::new(0);
fn mark_osd() {
    OSD_UNTIL.store(now_ms() + 1500, Ordering::Relaxed);
}

/// Setelah berapa detik tanpa input notch masuk mode "istirahat" (mata).
const IDLE_SECS: u64 = 15;

/// CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS untuk semua proses PowerShell.
const PS_FLAGS: u32 = 0x0800_0000 | 0x0000_4000;

fn ro_init() {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

thread_local! {
    static COM_READY: Cell<bool> = Cell::new(false);
}

/// Inisialisasi COM sekali per thread (dipakai untuk Core Audio).
fn com_init() {
    COM_READY.with(|c| {
        if !c.get() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            c.set(true);
        }
    });
}

/// Jalankan PowerShell tanpa jendela (prioritas rendah), kembalikan stdout (UTF-8).
fn run_ps(script: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let full = format!("[Console]::OutputEncoding=[Text.Encoding]::UTF8; {script}");
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &full,
        ])
        .creation_flags(PS_FLAGS)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------------
// 1) MUSIK (Windows Global System Media Transport Controls)
// ---------------------------------------------------------------------
#[derive(Serialize, Clone, Default)]
struct MediaInfo {
    active: bool,
    title: String,
    artist: String,
    playing: bool,
    position: f64,
    duration: f64,
    art: Option<String>, // data URL; hanya dikirim saat lagu berganti
}

/// Pilih sesi media yang tepat saat beberapa aplikasi aktif sekaligus
/// (mis. Spotify + YouTube). Prioritas:
///   1) sesi "current" Windows, jika sedang memutar
///   2) sesi lain yang sedang memutar
///   3) sesi "current" (jeda), atau sesi pertama yang ada
/// Semua kontrol (play/next/prev/seek) memakai fungsi ini juga.
fn current_session() -> Option<Session> {
    let mgr = SessionManager::RequestAsync().ok()?.get().ok()?;
    let current = mgr.GetCurrentSession().ok();
    let is_playing = |s: &Session| {
        s.GetPlaybackInfo()
            .and_then(|p| p.PlaybackStatus())
            .map(|st| st == PlaybackStatus::Playing)
            .unwrap_or(false)
    };
    if let Some(c) = &current {
        if is_playing(c) {
            return current;
        }
    }
    if let Ok(list) = mgr.GetSessions() {
        for s in list {
            if is_playing(&s) {
                return Some(s);
            }
        }
    }
    current.or_else(|| mgr.GetSessions().ok()?.into_iter().next())
}

fn read_thumbnail(props: &MediaProps) -> Option<String> {
    let thumb = props.Thumbnail().ok()?;
    let stream = thumb.OpenReadAsync().ok()?.get().ok()?;
    let mime = stream
        .ContentType()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let rs: IRandomAccessStream = stream.cast().ok()?;
    let size = rs.Size().ok()? as u32;
    if size == 0 || size > 8_000_000 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&rs.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let mime = if mime.is_empty() { "image/png".into() } else { mime };
    Some(format!("data:{};base64,{}", mime, B64.encode(buf)))
}

fn read_media(cache: &mut (String, Option<String>)) -> MediaInfo {
    let Some(session) = current_session() else {
        return MediaInfo::default();
    };
    let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) else {
        return MediaInfo::default();
    };
    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    if title.is_empty() {
        return MediaInfo::default();
    }

    let key = format!("{artist}|{title}");
    if cache.0 != key {
        *cache = (key, read_thumbnail(&props));
    }

    let playing = session
        .GetPlaybackInfo()
        .and_then(|p| p.PlaybackStatus())
        .map(|s| s == PlaybackStatus::Playing)
        .unwrap_or(false);

    let (mut position, mut duration) = (0.0, 0.0);
    if let Ok(tl) = session.GetTimelineProperties() {
        let start = tl.StartTime().map(|t| t.Duration).unwrap_or(0);
        let end = tl.EndTime().map(|t| t.Duration).unwrap_or(0);
        let pos = tl.Position().map(|t| t.Duration).unwrap_or(0);
        duration = ((end - start) as f64 / 10_000_000.0).max(0.0);
        let base_pos = ((pos - start) as f64 / 10_000_000.0).max(0.0);

        // Timeline GSMTC Windows mencatat posisi pada LastUpdatedTime.
        // Jika sedang memutar, tambahkan waktu yang sudah berlalu sejak update terakhir
        // agar posisi real-time dan lirik karaoke tidak tertinggal/delay beberapa detik.
        if playing {
            if let Ok(lut) = tl.LastUpdatedTime() {
                let ft = unsafe { GetSystemTimeAsFileTime() };
                let now_ticks = ((ft.dwHighDateTime as i64) << 32) | (ft.dwLowDateTime as i64);
                let diff_ticks = now_ticks - lut.UniversalTime;
                if diff_ticks > 0 {
                    let elapsed = diff_ticks as f64 / 10_000_000.0;
                    if elapsed < 120.0 {
                        position = if duration > 0.0 {
                            (base_pos + elapsed).min(duration)
                        } else {
                            base_pos + elapsed
                        };
                    } else {
                        position = base_pos;
                    }
                } else {
                    position = base_pos;
                }
            } else {
                position = base_pos;
            }
        } else {
            position = base_pos;
        }
    }

    MediaInfo {
        active: true,
        title,
        artist,
        playing,
        position,
        duration,
        art: cache.1.clone(),
    }
}

fn media_thread(app: AppHandle) {
    thread::spawn(move || {
        ro_init();
        let mut cache: (String, Option<String>) = (String::new(), None);
        let mut last = MediaInfo::default();
        let mut tick: u32 = 0;
        loop {
            let info = read_media(&mut cache);
            let changed = info.active != last.active
                || info.title != last.title
                || info.artist != last.artist
                || info.playing != last.playing
                || (info.duration - last.duration).abs() > 1.0;
            if changed {
                let _ = app.emit("media", &info);
            } else if info.playing && tick % 2 == 0 {
                // sinkronisasi posisi tiap 500ms saat memutar lagu agar lirik selalu tepat waktu
                let mut light = info.clone();
                light.art = None;
                let _ = app.emit("media", &light);
            }
            last = info;
            tick = tick.wrapping_add(1);
            thread::sleep(Duration::from_millis(250));
        }
    });
}

#[tauri::command]
async fn media_toggle() {
    ro_init();
    if let Some(s) = current_session() {
        if let Ok(op) = s.TryTogglePlayPauseAsync() {
            let _ = op.get();
        }
    }
}

#[tauri::command]
async fn media_next() {
    ro_init();
    if let Some(s) = current_session() {
        if let Ok(op) = s.TrySkipNextAsync() {
            let _ = op.get();
        }
    }
}

#[tauri::command]
async fn media_prev() {
    ro_init();
    if let Some(s) = current_session() {
        if let Ok(op) = s.TrySkipPreviousAsync() {
            let _ = op.get();
        }
    }
}

#[tauri::command]
async fn media_seek(seconds: f64) {
    ro_init();
    if let Some(s) = current_session() {
        let ticks = (seconds.max(0.0) * 10_000_000.0) as i64;
        if let Ok(op) = s.TryChangePlaybackPositionAsync(ticks) {
            let _ = op.get();
        }
    }
}

// ---------------------------------------------------------------------
// 2) LIRIK (LRCLIB) dengan pembersih judul, fallback search, dan cache
//    Mendukung lirik bersinkronisasi (syncedLyrics) dan teks biasa (plainLyrics).
// ---------------------------------------------------------------------

/// Kata-kata "sampah" yang sering menempel di judul YouTube/Spotify.
const NOISE: &[&str] = &[
    "official", "lyric", "video", "audio", "visualizer", "mv", "hd", "hq", "4k",
    "remaster", "live", "feat", "ft", "clip", "explicit", "edit", "karaoke",
    "topic", "vevo", "performance", "soundtrack",
];

fn is_noise(text: &str) -> bool {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .any(|w| {
            let w = w.to_lowercase();
            NOISE.iter().any(|n| w.starts_with(n))
        })
}

fn closes(open: char, close: char) -> bool {
    matches!(
        (open, close),
        ('(', ')') | ('[', ']') | ('【', '】') | ('（', '）')
    )
}

/// Hapus isi kurung yang mengandung kata sampah, mis. "(Official Video)", "[HD]".
fn strip_noise_brackets(s: &str) -> String {
    let mut out = String::new();
    let mut buf = String::new();
    let mut open: Option<char> = None;
    for c in s.chars() {
        match (open, c) {
            (None, '(' | '[' | '【' | '（') => {
                open = Some(c);
                buf.clear();
            }
            (Some(o), ')' | ']' | '】' | '）') if closes(o, c) => {
                if !is_noise(&buf) {
                    out.push(o);
                    out.push_str(&buf);
                    out.push(c);
                }
                open = None;
            }
            (Some(_), _) => buf.push(c),
            (None, _) => out.push(c),
        }
    }
    if let Some(o) = open {
        out.push(o);
        out.push_str(&buf);
    }
    out
}

/// Potong "feat. X" / "ft. X" dan sesudahnya.
fn cut_feat(s: &str) -> &str {
    let low = s.to_ascii_lowercase(); // panjang byte sama dengan aslinya
    let mut cut = s.len();
    for p in [" feat.", " feat ", " ft.", " ft ", " featuring "] {
        if let Some(i) = low.find(p) {
            cut = cut.min(i);
        }
    }
    &s[..cut]
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_title(s: &str) -> String {
    let no_br = strip_noise_brackets(s);
    let mut t: &str = no_br.as_str();
    if let Some(i) = t.find(" | ") {
        t = &t[..i];
    }
    // "Judul - Remastered 2011", "Judul - Radio Edit", "Judul - Live"
    while let Some((l, r)) = t.rsplit_once(" - ") {
        if is_noise(r) {
            t = l;
        } else {
            break;
        }
    }
    collapse_ws(cut_feat(t))
}

fn clean_artist(s: &str) -> String {
    let mut a = strip_noise_brackets(s);
    // "Artis - Topic", "ArtisVEVO", "Artis Official"
    if let Some((l, r)) = a.clone().rsplit_once(" - ") {
        if is_noise(r) {
            a = l.to_string();
        }
    }
    let low = a.to_lowercase();
    for suf in ["vevo", " official", " topic"] {
        if low.ends_with(suf) {
            a.truncate(a.len() - suf.len());
            break;
        }
    }
    let a = cut_feat(&a).to_string();
    // multi-artis: ambil yang pertama saja
    let first = a
        .split(|c: char| c == ',' || c == '&' || c == ';')
        .next()
        .unwrap_or(&a);
    collapse_ws(first)
}

fn http_json(url: &str, params: &[(&str, &str)]) -> Option<Value> {
    let mut req = ureq::get(url)
        .set("User-Agent", "migi/0.1.0 (https://lrclib.net)")
        .timeout(Duration::from_secs(8));
    for (k, v) in params {
        req = req.query(k, v);
    }
    let body = req.call().ok()?.into_string().ok()?;
    serde_json::from_str(&body).ok()
}

/// Hasil lirik untuk UI. `synced` = true -> format LRC bertimestamp,
/// false -> teks biasa tanpa timestamp.
#[derive(Serialize, Clone)]
struct Lyrics {
    synced: bool,
    text: String,
}

/// Ambil syncedLyrics dulu; kalau kosong pakai plainLyrics.
fn lyr_of(v: &Value) -> Option<Lyrics> {
    let pick = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if let Some(t) = pick("syncedLyrics") {
        return Some(Lyrics { synced: true, text: t });
    }
    pick("plainLyrics").map(|t| Lyrics { synced: false, text: t })
}

/// /api/get: pencocokan ketat (artis + judul [+ durasi]).
fn lrclib_get(artist: &str, title: &str, duration: u32) -> Option<Lyrics> {
    let dur = duration.to_string();
    let mut params = vec![("artist_name", artist), ("track_name", title)];
    if duration > 0 {
        params.push(("duration", dur.as_str()));
    }
    lyr_of(&http_json("https://lrclib.net/api/get", &params)?)
}

/// /api/search: toleran. Utamakan yang bersinkronisasi, lalu durasi paling dekat.
fn lrclib_search(q: &str, duration: u32) -> Option<Lyrics> {
    let v = http_json("https://lrclib.net/api/search", &[("q", q)])?;
    v.as_array()?
        .iter()
        .filter_map(|it| {
            let l = lyr_of(it)?;
            let d = it.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0);
            let diff = if duration > 0 && d > 0.0 {
                (d - duration as f64).abs()
            } else {
                0.0
            };
            if duration > 0 && diff > 15.0 {
                return None;
            }
            Some((if l.synced { 0u8 } else { 1u8 }, diff, l))
        })
        .min_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        })
        .map(|x| x.2)
}

/// Daftar kandidat (artis, judul) yang dicoba berurutan.
fn candidates(artist: &str, title: &str) -> Vec<(String, String)> {
    let ct = clean_title(title);
    let ca = clean_artist(artist);
    let mut list: Vec<(String, String)> = Vec::new();
    let mut push = |a: String, t: String| {
        if t.is_empty() {
            return;
        }
        let key = (a.to_lowercase(), t.to_lowercase());
        if !list
            .iter()
            .any(|(x, y)| (x.to_lowercase(), y.to_lowercase()) == key)
        {
            list.push((a, t));
        }
    };
    push(artist.trim().to_string(), title.trim().to_string()); // data mentah
    push(ca.clone(), ct.clone()); // data dibersihkan
    // YouTube: judul berformat "Artis - Judul"
    if let Some((l, r)) = ct.split_once(" - ") {
        push(clean_artist(l), clean_title(r));
        push(clean_artist(r), clean_title(l)); // kadang terbalik
    }
    list
}

/// Hasil bersinkronisasi langsung dipakai (true = berhenti mencari);
/// hasil teks biasa hanya disimpan sebagai cadangan.
fn take(l: Option<Lyrics>, found: &mut Option<Lyrics>, plain: &mut Option<Lyrics>) -> bool {
    match l {
        Some(l) if l.synced => {
            *found = Some(l);
            true
        }
        Some(l) => {
            if plain.is_none() {
                *plain = Some(l);
            }
            false
        }
        None => false,
    }
}

// Cache hasil sukses (maks 50 lagu). Kegagalan tidak disimpan
// supaya masalah jaringan sesaat tidak "mengunci" lagu itu.
static LYRIC_CACHE: Mutex<Vec<(String, Lyrics)>> = Mutex::new(Vec::new());

fn find_lyrics(artist: &str, title: &str, duration: u32) -> Option<Lyrics> {
    let key = format!("{}|{}", artist.to_lowercase(), title.to_lowercase());
    if let Ok(c) = LYRIC_CACHE.lock() {
        if let Some((_, v)) = c.iter().find(|(k, _)| *k == key) {
            return Some(v.clone());
        }
    }

    let cands = candidates(artist, title);
    let mut found: Option<Lyrics> = None;
    let mut plain: Option<Lyrics> = None;

    // 1) /api/get dengan durasi, lalu tanpa durasi
    'outer: for (a, t) in &cands {
        if a.is_empty() {
            continue;
        }
        for d in [duration, 0] {
            if take(lrclib_get(a, t, d), &mut found, &mut plain) {
                break 'outer;
            }
            if duration == 0 {
                break;
            }
        }
    }

    // 2) /api/search: "artis judul", lalu judul saja
    if found.is_none() {
        for (a, t) in &cands {
            let q = if a.is_empty() {
                t.clone()
            } else {
                format!("{a} {t}")
            };
            if take(lrclib_search(&q, duration), &mut found, &mut plain) {
                break;
            }
        }
    }
    if found.is_none() {
        if let Some((_, t)) = cands.get(1).or(cands.first()) {
            take(lrclib_search(t, duration), &mut found, &mut plain);
        }
    }

    // tidak ada yang bersinkronisasi -> pakai teks biasa (kalau ada)
    let found = found.or(plain);

    if let (Some(s), Ok(mut c)) = (&found, LYRIC_CACHE.lock()) {
        c.retain(|(k, _)| *k != key);
        c.push((key, s.clone()));
        if c.len() > 50 {
            c.remove(0);
        }
    }
    found
}

#[tauri::command]
async fn fetch_lyrics(artist: String, title: String, duration: u32) -> Option<Lyrics> {
    tauri::async_runtime::spawn_blocking(move || find_lyrics(&artist, &title, duration))
        .await
        .ok()
        .flatten()
}

// ---------------------------------------------------------------------
// 3) BATERAI & CHARGER (hanya aktif jika perangkat punya baterai)
// ---------------------------------------------------------------------
#[derive(Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
struct PowerInfo {
    has_battery: bool,
    charging: bool,
    percent: u8,
}

fn read_power() -> PowerInfo {
    unsafe {
        let mut s = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut s).is_err() {
            return PowerInfo::default();
        }
        // BatteryFlag 128 = tidak ada baterai, 255 = tidak diketahui
        let has_battery = s.BatteryFlag != 128 && s.BatteryFlag != 255;
        PowerInfo {
            has_battery,
            charging: has_battery && s.ACLineStatus == 1,
            percent: if s.BatteryLifePercent <= 100 { s.BatteryLifePercent } else { 0 },
        }
    }
}

#[tauri::command]
fn get_power() -> PowerInfo {
    read_power()
}

// ---------------------------------------------------------------------
// 4) IDLE & APLIKASI MAXIMIZE / FULLSCREEN
// ---------------------------------------------------------------------
fn idle_secs() -> u64 {
    unsafe {
        let mut l = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut l).as_bool() {
            (GetTickCount().wrapping_sub(l.dwTime) / 1000) as u64
        } else {
            0
        }
    }
}

const SHELL_CLASSES: &[&str] = &[
    "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
    "TaskListThumbnailWnd", "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland", "XamlExplorerHostIslandWindow",
    "Windows.UI.Core.CoreWindow",
];

unsafe fn class_of(hwnd: HWND) -> String {
    let mut cls = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut cls).max(0) as usize;
    String::from_utf16_lossy(&cls[..n])
}

unsafe fn is_cloaked(hwnd: HWND) -> bool {
    let mut v: u32 = 0;
    DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut v as *mut _ as *mut _,
        std::mem::size_of::<u32>() as u32,
    )
    .is_ok()
        && v != 0
}

/// Jendela yang benar-benar tampil di layar (bukan minimize/hidden/cloaked/shell)
unsafe fn is_relevant(hwnd: HWND) -> bool {
    IsWindowVisible(hwnd).as_bool()
        && !IsIconic(hwnd).as_bool()
        && !is_cloaked(hwnd)
        && !SHELL_CLASSES.contains(&class_of(hwnd).as_str())
}

unsafe fn covers_screen(hwnd: HWND) -> bool {
    if IsZoomed(hwnd).as_bool() {
        return true;
    }
    let mut r = RECT::default();
    GetWindowRect(hwnd, &mut r).is_ok()
        && r.left <= 0
        && r.top <= 0
        && r.right >= GetSystemMetrics(SM_CXSCREEN)
        && r.bottom >= GetSystemMetrics(SM_CYSCREEN)
}

fn foreground_maximized() -> bool {
    unsafe {
        let own_pid = std::process::id();
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid != own_pid {
            return is_relevant(fg) && covers_screen(fg);
        }

        // Foreground = migi sendiri: telusuri z-order ke bawah, cari jendela
        // lain yang masih tampil dan menutupi layar.
        let mut hwnd = fg;
        for _ in 0..200 {
            hwnd = match GetWindow(hwnd, GW_HWNDNEXT) {
                Ok(h) if !h.0.is_null() => h,
                _ => break,
            };
            let mut p = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut p));
            if p == own_pid {
                continue;
            }
            if is_relevant(hwnd) && covers_screen(hwnd) {
                return true;
            }
        }
        false
    }
}

// ---------------------------------------------------------------------
// 5) CLIPBOARD & JENDELA
// ---------------------------------------------------------------------
#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Dipanggil sekali saat start: jendela dibuat seukuran mode terbesar
/// dan ditaruh di tengah atas layar. Setelah itu tidak di-resize lagi.
/// Bentuk notch sepenuhnya digambar CSS (anti-aliased); area jendela yang
/// kosong transparan dan dibuat click-through oleh `hover_thread`.
#[tauri::command]
fn place_notch(app: AppHandle, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(h_raw) = win.hwnd() {
            let hwnd = HWND(h_raw.0 as *mut _);
            let factor = win.scale_factor().unwrap_or(1.0);
            let win_w = ((w + 24.0) * factor).round() as i32;
            let win_h = (h * factor).round() as i32;

            let (screen_x, screen_w) = if let Ok(Some(mon)) = win.current_monitor() {
                (mon.position().x, mon.size().width as i32)
            } else {
                (0, unsafe { GetSystemMetrics(SM_CXSCREEN) })
            };

            let x = screen_x + (screen_w - win_w) / 2;
            let y = 0;

            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
                    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
                    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
                };
                // migi tidak pernah merebut fokus (opsional; hapus 3 baris ini
                // dan SWP_FRAMECHANGED jika ada efek aneh)
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(
                    hwnd,
                    GWL_EXSTYLE,
                    ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
                );
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    x,
                    y,
                    win_w,
                    win_h,
                    SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOZORDER | SWP_FRAMECHANGED,
                );
            }
        }
    }
}

/// Zona hover (piksel logis), dikonversi ke piksel fisik di sini.
#[tauri::command]
fn set_hot(app: AppHandle, w: f64, h: f64) {
    let f = app
        .get_webview_window("main")
        .and_then(|win| win.scale_factor().ok())
        .unwrap_or(1.0);
    HOT_W.store((w * f).round() as u32, Ordering::Relaxed);
    HOT_H.store((h * f).round() as u32, Ordering::Relaxed);
}

// Satu thread untuk idle, maximize, baterai, volume, dan clipboard (tiap 0,5 detik)
fn monitor_thread(app: AppHandle) {
    thread::spawn(move || {
        let mut resting = false;
        let mut maxed = false;
        let mut power = read_power();
        let mut clip_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            let r = idle_secs() >= IDLE_SECS;
            if r != resting {
                resting = r;
                let _ = app.emit("idle", r);
            }

            let m = foreground_maximized();
            if m != maxed {
                maxed = m;
                let _ = app.emit("maximized", m);
            }

            let p = read_power();
            if p != power {
                power = p.clone();
                let _ = app.emit("power", p);
            }

            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq != clip_seq {
                clip_seq = seq;
                if let Ok(text) = arboard::Clipboard::new().and_then(|mut c| c.get_text()) {
                    if !text.trim().is_empty() {
                        let _ = app.emit("clipboard", text);
                    }
                }
            }

            thread::sleep(Duration::from_millis(500));
        }
    });
}

// ---------------------------------------------------------------------
// 6) BLUETOOTH (perangkat tersambung / terputus)
//    Bagian ini paling rawan error compile. Jika bermasalah, beri komentar
//    pada baris `bluetooth_watch(...)` di main() dan fitur lain tetap jalan.
//    Watcher memakai filter "Connected": `Added` = perangkat tersambung,
//    `Removed` = perangkat tidak lagi tersambung (terputus).
//    Setiap event juga membatalkan cache daftar perangkat (lihat bagian 10).
// ---------------------------------------------------------------------
#[derive(Serialize, Clone)]
struct BtInfo {
    name: String,
    connected: bool,
    battery: Option<u8>,
}

fn bluetooth_watch(app: AppHandle) {
    thread::spawn(move || {
        ro_init();
        let run = || -> windows::core::Result<DeviceWatcher> {
            let selector = BluetoothDevice::GetDeviceSelectorFromConnectionStatus(
                BluetoothConnectionStatus::Connected,
            )?;
            let watcher = DeviceInformation::CreateWatcherAqsFilter(&selector)?;

            // Perangkat yang sudah tersambung saat migi dibuka diabaikan:
            // notifikasi baru dikirim setelah pendataan awal selesai.
            let ready = Arc::new(AtomicBool::new(false));

            // id perangkat -> nama, supaya event Removed (hanya membawa id) bisa diberi nama
            let names: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

            let ready_done = ready.clone();
            watcher.EnumerationCompleted(&TypedEventHandler::<DeviceWatcher, IInspectable>::new(
                move |_, _| {
                    ready_done.store(true, Ordering::SeqCst);
                    Ok(())
                },
            ))?;

            let ready_added = ready.clone();
            let app_added = app.clone();
            let names_added = names.clone();
            watcher.Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(
                move |_, info: &Option<DeviceInformation>| {
                    invalidate_devices();
                    if let Some(info) = info.as_ref() {
                        let id = info.Id().map(|s| s.to_string()).unwrap_or_default();
                        let name = info.Name().map(|n| n.to_string()).unwrap_or_default();
                        // dicatat juga untuk perangkat yang sudah tersambung saat migi dibuka
                        if let Ok(mut m) = names_added.lock() {
                            m.insert(id, name.clone());
                        }
                        if ready_added.load(Ordering::SeqCst) {
                            let _ = app_added.emit(
                                "bluetooth",
                                BtInfo { name, connected: true, battery: None },
                            );
                        }
                    }
                    Ok(())
                },
            ))?;

            let ready_removed = ready.clone();
            let app_removed = app.clone();
            let names_removed = names.clone();
            watcher.Removed(&TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(
                move |_, upd: &Option<DeviceInformationUpdate>| {
                    invalidate_devices();
                    if let Some(u) = upd.as_ref() {
                        let id = u.Id().map(|s| s.to_string()).unwrap_or_default();
                        let name = names_removed
                            .lock()
                            .ok()
                            .and_then(|mut m| m.remove(&id))
                            .unwrap_or_default();
                        if ready_removed.load(Ordering::SeqCst) {
                            let _ = app_removed.emit(
                                "bluetooth",
                                BtInfo { name, connected: false, battery: None },
                            );
                        }
                    }
                    Ok(())
                },
            ))?;

            watcher.Start()?;
            Ok(watcher)
        };

        match run() {
            // watcher harus tetap hidup selama aplikasi berjalan
            Ok(_watcher) => loop {
                thread::sleep(Duration::from_secs(3600));
            },
            Err(e) => eprintln!("bluetooth watcher gagal: {e}"),
        }
    });
}

// ---------------------------------------------------------------------
// 7) TRAY & JENDELA PENGATURAN
// ---------------------------------------------------------------------
struct TrayChecks {
    autostart: CheckMenuItem<tauri::Wry>,
    mascot: CheckMenuItem<tauri::Wry>,
    minimal: CheckMenuItem<tauri::Wry>,
    settings: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// Dibuat di thread terpisah: membuat window dari command/event handler
/// sinkron di Windows bisa deadlock (jendela jadi "Not Responding").
fn open_settings(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if let Some(w) = app.get_webview_window("settings") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let r = WebviewWindowBuilder::new(
            &app,
            "settings",
            WebviewUrl::App("index.html#settings".into()),
        )
        .title("Pengaturan migi")
        .inner_size(660.0, 520.0)
        .center()
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .build();
        if let Err(e) = r {
            eprintln!("gagal membuka pengaturan: {e}");
        }
    });
}

#[tauri::command]
fn show_settings(app: AppHandle) {
    open_settings(&app);
}

#[tauri::command]
fn close_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.close();
    }
}

#[tauri::command]
fn open_link(app: AppHandle, url: String) {
    let _ = app.opener().open_url(url, None::<&str>);
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, state: tauri::State<TrayChecks>, enabled: bool) -> bool {
    let al = app.autolaunch();
    let _ = if enabled { al.enable() } else { al.disable() };
    let on = al.is_enabled().unwrap_or(false);
    let _ = state.autostart.set_checked(on);
    on
}

/// Dipanggil UI agar centang menu tray selalu sama dengan pengaturan.
#[tauri::command]
fn sync_tray(state: tauri::State<TrayChecks>, mascot: bool, minimal: bool) {
    let _ = state.mascot.set_checked(mascot);
    let _ = state.minimal.set_checked(minimal);
}

/// Teks menu tray mengikuti bahasa UI ("id" / "en").
#[tauri::command]
fn set_tray_lang(state: tauri::State<TrayChecks>, lang: String) {
    let en = lang == "en";
    let _ = state.settings.set_text(if en { "Settings…" } else { "Pengaturan…" });
    let _ = state
        .autostart
        .set_text(if en { "Launch at Windows startup" } else { "Jalankan saat Windows menyala" });
    let _ = state.mascot.set_text(if en { "Migi mascot" } else { "Maskot migi" });
    let _ = state.minimal.set_text(if en { "Minimal notch" } else { "Notch minimal" });
    let _ = state.quit.set_text(if en { "Quit" } else { "Keluar" });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let auto_on = app.autolaunch().is_enabled().unwrap_or(false);
    let settings = MenuItem::with_id(app, "settings", "Pengaturan…", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Jalankan saat Windows menyala", true, auto_on, None::<&str>)?;
    let mascot = CheckMenuItem::with_id(app, "mascot", "Maskot migi", true, true, None::<&str>)?;
    let minimal = CheckMenuItem::with_id(app, "minimal", "Notch minimal", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&settings, &sep1, &autostart, &mascot, &minimal, &sep2, &quit],
    )?;

    app.manage(TrayChecks { autostart, mascot, minimal, settings, quit });

    let mut builder = TrayIconBuilder::new()
        .tooltip("migi")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => open_settings(app),
            "autostart" => {
                let al = app.autolaunch();
                let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
            }
            id @ ("mascot" | "minimal") => {
                let _ = app.emit("tray_toggle", id);
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------
// 8) HOVER & CLICK-THROUGH (dipantau lewat posisi kursor, tidak bergantung fokus WebView)
//    Event "hover" dikirim saat kursor masuk zona notch. Saat keluar, status
//    ditahan 100 ms dulu supaya tidak berkedip jika kursor sekilas keluar.
//    Selama kursor di luar zona, jendela diset click-through sehingga area
//    transparan tidak menghalangi aplikasi di bawahnya.
// ---------------------------------------------------------------------
fn hover_thread(app: AppHandle) {
    thread::spawn(move || {
        let mut hwnd_raw: Option<isize> = None;
        let mut inside = false;
        let mut left_at: Option<Instant> = None;
        let mut ignoring: Option<bool> = None;
        loop {
            if hwnd_raw.is_none() {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(h) = win.hwnd() {
                        hwnd_raw = Some(h.0 as isize);
                    }
                }
            }
            if let Some(raw) = hwnd_raw {
                let hwnd = HWND(raw as *mut _);
                let mut r = RECT::default();
                let mut pt = POINT::default();
                let ok = unsafe { GetWindowRect(hwnd, &mut r).is_ok() && GetCursorPos(&mut pt).is_ok() };
                if ok {
                    let hw = HOT_W.load(Ordering::Relaxed) as i32;
                    let hh = HOT_H.load(Ordering::Relaxed) as i32;
                    let cx = (r.left + r.right) / 2;
                    let now_inside = hw > 0
                        && pt.x >= cx - hw / 2
                        && pt.x <= cx + hw / 2
                        && pt.y >= r.top
                        && pt.y <= r.top + hh;

                    if now_inside {
                        left_at = None;
                        if !inside {
                            inside = true;
                            let _ = app.emit("hover", true);
                        }
                    } else if inside {
                        let t = *left_at.get_or_insert_with(Instant::now);
                        if t.elapsed() >= Duration::from_millis(100) {
                            inside = false;
                            left_at = None;
                            let _ = app.emit("hover", false);
                        }
                    }
                }
            }

            // Di luar zona notch, klik menembus jendela ke aplikasi di bawahnya.
            // Tanpa delay: segera interaktif begitu kursor masuk zona.
            if let Some(win) = app.get_webview_window("main") {
                let want_ignore = !inside;
                if ignoring != Some(want_ignore) && win.set_ignore_cursor_events(want_ignore).is_ok() {
                    ignoring = Some(want_ignore);
                }
            }

            thread::sleep(Duration::from_millis(16));
        }
    });
}

// ---------------------------------------------------------------------
// 9) NOTIFIKASI WINDOWS
//    Jalur utama: UserNotificationListener (butuh izin + package identity).
//    Jalur cadangan: baca langsung wpndatabase.db (database Action Center),
//    dipakai otomatis jika akses ditolak (exe biasa tanpa package identity).
//    Status dikirim ke UI lewat `get_notify_access` / event "notify_access".
// ---------------------------------------------------------------------
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotifyInfo {
    id: u32,
    app: String,
    title: String,
    body: String,
    at: u64, // epoch ms
    icon: Option<String>,      // logo aplikasi pengirim (data URL PNG)
    site: Option<String>,      // domain situs (notifikasi dari browser)
    site_icon: Option<String>, // favicon situs (data URL)
}

static NOTIFS: Mutex<Vec<NotifyInfo>> = Mutex::new(Vec::new());
static NOTIFY_ACCESS: AtomicU8 = AtomicU8::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// --- Ikon aplikasi (dari Shell Windows) & ikon situs (favicon Google), keduanya di-cache ---
/// Diatur dari Pengaturan lewat `set_site_icons`.
static SITE_ICONS: AtomicBool = AtomicBool::new(true);
static APP_ICONS: Mutex<Vec<(String, Option<String>)>> = Mutex::new(Vec::new());
static FAVICONS: Mutex<Vec<(String, Option<String>)>> = Mutex::new(Vec::new());

/// Ambil dari cache; kalau belum ada, buat (tanpa menahan lock) lalu simpan.
fn cached(
    cache: &Mutex<Vec<(String, Option<String>)>>,
    key: &str,
    make: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if let Ok(c) = cache.lock() {
        if let Some((_, v)) = c.iter().find(|(k, _)| k == key) {
            return v.clone();
        }
    }
    let v = make();
    if let Ok(mut c) = cache.lock() {
        c.push((key.to_string(), v.clone()));
        if c.len() > 100 {
            c.remove(0);
        }
    }
    v
}

/// HBITMAP 32-bit -> PNG (RGBA).
unsafe fn hbitmap_to_png(hbmp: HBITMAP) -> Option<Vec<u8>> {
    let mut bm = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(hbmp.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut BITMAP as *mut _),
    );
    if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    let mut bi = BITMAPINFO::default();
    bi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0, // BI_RGB
        ..Default::default()
    };
    let mut px = vec![0u8; (w * h * 4) as usize];
    let hdc = GetDC(HWND::default());
    let lines = GetDIBits(
        hdc,
        hbmp,
        0,
        h as u32,
        Some(px.as_mut_ptr() as *mut _),
        &mut bi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(HWND::default(), hdc);
    if lines == 0 {
        return None;
    }
    // BGRA -> RGBA; kalau bitmap tidak punya alpha sama sekali, jadikan opak
    let mut any_alpha = false;
    for c in px.chunks_exact_mut(4) {
        c.swap(0, 2);
        if c[3] != 0 {
            any_alpha = true;
        }
    }
    if !any_alpha {
        for c in px.chunks_exact_mut(4) {
            c[3] = 255;
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().ok()?;
        wr.write_image_data(&px).ok()?;
    }
    Some(out)
}

/// Ikon aplikasi dari AppUserModelId lewat Shell (`shell:AppsFolder\<AUMID>`).
fn aumid_icon(aumid: &str) -> Option<String> {
    com_init();
    unsafe {
        let path: Vec<u16> = format!("shell:AppsFolder\\{aumid}")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let item: IShellItem = SHCreateItemFromParsingName(
            PCWSTR(path.as_ptr()),
            None::<&windows::Win32::System::Com::IBindCtx>,
        )
        .ok()?;
        let factory: IShellItemImageFactory = item.cast().ok()?;
        let hbmp = factory
            .GetImage(SIZE { cx: 64, cy: 64 }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)
            .ok()?;
        let png = hbitmap_to_png(hbmp);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        png.map(|b| format!("data:image/png;base64,{}", B64.encode(b)))
    }
}

fn app_icon(aumid: &str) -> Option<String> {
    if aumid.is_empty() {
        return None;
    }
    cached(&APP_ICONS, aumid, || aumid_icon(aumid))
}

fn is_browser(s: &str) -> bool {
    let l = s.to_lowercase();
    ["chrome", "edge", "firefox", "brave", "opera", "vivaldi"]
        .iter()
        .any(|k| l.contains(k))
}

/// "https://www.youtube.com/watch" / "www.youtube.com" -> "youtube.com".
/// Mengembalikan None kalau teksnya bukan domain.
fn site_from_text(s: &str) -> Option<String> {
    let mut h = s.trim().to_lowercase();
    for p in ["https://", "http://"] {
        if let Some(r) = h.strip_prefix(p) {
            h = r.to_string();
        }
    }
    let host = h
        .split(|c: char| c == '/' || c == ':' || c == '?')
        .next()?
        .trim()
        .to_string();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let ok = host.len() >= 3
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if ok { Some(host) } else { None }
}

/// Favicon lewat layanan Google. Hanya nama domain yang dikirim.
fn fetch_favicon(host: &str) -> Option<String> {
    use std::io::Read;
    let resp = ureq::get("https://www.google.com/s2/favicons")
        .set("User-Agent", "migi/0.1.0")
        .query("domain", host)
        .query("sz", "64")
        .timeout(Duration::from_secs(3))
        .call()
        .ok()?;
    let ct = resp.content_type().to_string();
    let mut buf = Vec::new();
    resp.into_reader().take(300_000).read_to_end(&mut buf).ok()?;
    if buf.is_empty() {
        return None;
    }
    let ct = if ct.starts_with("image/") { ct } else { "image/png".to_string() };
    Some(format!("data:{};base64,{}", ct, B64.encode(buf)))
}

fn favicon(host: &str) -> Option<String> {
    cached(&FAVICONS, host, || fetch_favicon(host))
}

/// Susun NotifyInfo + ikon. `texts` tidak boleh kosong.
fn make_info(
    id: u32,
    aumid: &str,
    app: String,
    mut texts: Vec<String>,
    attribution: Option<String>,
    at: u64,
) -> NotifyInfo {
    let browser = is_browser(&app) || is_browser(aumid);
    let mut site = if browser {
        attribution.as_deref().and_then(site_from_text)
    } else {
        None
    };
    // jalur listener: atribusi ikut sebagai teks terakhir (judul, isi, domain)
    if browser && site.is_none() && texts.len() >= 3 {
        if let Some(s) = site_from_text(texts.last().map(|t| t.as_str()).unwrap_or("")) {
            site = Some(s);
            texts.pop();
        }
    }
    let site_icon = match (&site, SITE_ICONS.load(Ordering::Relaxed)) {
        (Some(s), true) => favicon(s),
        _ => None,
    };
    let icon = app_icon(aumid);
    let title = texts.first().cloned().unwrap_or_default();
    let body = if texts.len() > 1 { texts[1..].join(" ") } else { String::new() };
    NotifyInfo { id, app, title, body, at, icon, site, site_icon }
}

fn read_notification(n: &UserNotification) -> Option<NotifyInfo> {
    let id = n.Id().ok()?;
    let ai = n.AppInfo().ok()?;
    let aumid = ai
        .AppUserModelId()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let app = ai.DisplayInfo().ok()?.DisplayName().ok()?.to_string();
    let binding = n
        .Notification()
        .ok()?
        .Visual()
        .ok()?
        .GetBinding(&KnownNotificationBindings::ToastGeneric().ok()?)
        .ok()?;
    let texts: Vec<String> = binding
        .GetTextElements()
        .ok()?
        .into_iter()
        .filter_map(|t| t.Text().ok().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .collect();
    if texts.is_empty() {
        return None;
    }
    Some(make_info(id, &aumid, app, texts, None, now_ms()))
}

// --- Fallback: baca wpndatabase.db (Action Center) ---
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Ambil semua elemen <text> dari XML toast. Teks atribusi (biasanya domain
/// situs pada notifikasi browser) dikembalikan terpisah.
fn toast_texts(xml: &str) -> (Vec<String>, Option<String>) {
    let mut out = Vec::new();
    let mut attribution: Option<String> = None;
    let mut rest = xml;
    while let Some(i) = rest.find("<text") {
        let after = &rest[i + 5..];
        let next = after.chars().next().unwrap_or('x');
        if !(next == '>' || next.is_whitespace() || next == '/') {
            rest = after;
            continue;
        }
        let Some(gt) = after.find('>') else { break };
        let attrs = &after[..gt];
        let content = &after[gt + 1..];
        if attrs.trim_end().ends_with('/') {
            rest = content;
            continue;
        }
        let Some(end) = content.find("</text>") else { break };
        let raw = content[..end].trim();
        rest = &content[end + 7..];
        if raw.is_empty() {
            continue;
        }
        if attrs.contains("attribution") {
            if attribution.is_none() {
                attribution = Some(xml_unescape(raw));
            }
            continue;
        }
        out.push(xml_unescape(raw));
    }
    (out, attribution)
}

fn app_from_id(id: &str) -> String {
    let low = id.to_lowercase();
    for (k, v) in [
        ("whatsapp", "WhatsApp"), ("telegram", "Telegram"), ("discord", "Discord"),
        ("chrome", "Chrome"), ("msedge", "Edge"), ("firefox", "Firefox"),
        ("brave", "Brave"), ("opera", "Opera"), ("vivaldi", "Vivaldi"),
        ("outlook", "Outlook"), ("teams", "Teams"), ("slack", "Slack"),
        ("spotify", "Spotify"),
    ] {
        if low.contains(k) {
            return v.to_string();
        }
    }
    let base = id.split('!').next().unwrap_or(id);
    let base = base.split('_').next().unwrap_or(base);
    let name = base
        .rsplit(|c: char| c == '.' || c == '\\' || c == '/')
        .next()
        .unwrap_or(base);
    if name.is_empty() { "Aplikasi".to_string() } else { name.to_string() }
}

fn payload_to_string(b: &[u8]) -> String {
    // sebagian payload bisa UTF-16LE
    if b.len() > 2 && b[1] == 0 {
        let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    String::from_utf8_lossy(b).to_string()
}

fn wpn_poll(
    last_id: &mut i64,
    first: &mut bool,
    last_mtime: &mut Option<SystemTime>,
    app: &AppHandle,
) {
    let Ok(local) = std::env::var("LOCALAPPDATA") else { return };
    let src_dir = PathBuf::from(local).join("Microsoft").join("Windows").join("Notifications");
    let names = ["wpndatabase.db", "wpndatabase.db-wal", "wpndatabase.db-shm"];

    // lewati kalau database belum berubah sejak polling terakhir
    let mtime = names
        .iter()
        .filter_map(|n| std::fs::metadata(src_dir.join(n)).ok().and_then(|m| m.modified().ok()))
        .max();
    if mtime.is_none() || (!*first && mtime == *last_mtime) {
        return;
    }

    // salin ke folder temp (database aslinya dipakai Windows)
    let tmp = std::env::temp_dir().join("migi_wpn");
    let _ = std::fs::create_dir_all(&tmp);
    for n in names {
        let s = src_dir.join(n);
        let d = tmp.join(n);
        if s.exists() {
            if std::fs::copy(&s, &d).is_err() && n == names[0] {
                return;
            }
        } else {
            let _ = std::fs::remove_file(&d);
        }
    }

    let Ok(conn) = rusqlite::Connection::open(tmp.join(names[0])) else { return };
    let sql = "SELECT n.Id, n.Payload, h.PrimaryId, n.ArrivalTime \
               FROM Notification n LEFT JOIN NotificationHandler h ON n.HandlerId = h.RecordId \
               WHERE n.Id > ?1 ORDER BY n.Id ASC";
    let Ok(mut st) = conn.prepare(sql) else { return };
    let rows = st.query_map([*last_id], |r| {
        let id: i64 = r.get(0)?;
        let payload: Vec<u8> = match r.get_ref(1)? {
            rusqlite::types::ValueRef::Blob(b) => b.to_vec(),
            rusqlite::types::ValueRef::Text(t) => t.to_vec(),
            _ => Vec::new(),
        };
        let pid: String = r.get::<_, Option<String>>(2)?.unwrap_or_default();
        let arrival: i64 = r.get::<_, Option<i64>>(3)?.unwrap_or(0);
        Ok((id, payload, pid, arrival))
    });
    let Ok(rows) = rows else { return };
    let list: Vec<(i64, Vec<u8>, String, i64)> = rows.filter_map(Result::ok).collect();

    for (id, ..) in list.iter() {
        *last_id = (*last_id).max(*id);
    }
    // saat pertama kali, hanya isi riwayat Dashboard (20 terakhir) tanpa memunculkan pill
    let from = if *first { list.len().saturating_sub(20) } else { 0 };
    for (id, payload, pid, arrival) in &list[from..] {
        let xml = payload_to_string(payload);
        let (texts, attribution) = toast_texts(&xml);
        if texts.is_empty() {
            continue;
        }
        let at = if *arrival > 116_444_736_000_000_000 {
            ((*arrival - 116_444_736_000_000_000) / 10_000) as u64
        } else {
            now_ms()
        };
        let info = make_info(*id as u32, pid, app_from_id(pid), texts, attribution, at);
        if let Ok(mut store) = NOTIFS.lock() {
            store.insert(0, info.clone());
            store.truncate(20);
        }
        if !*first {
            let _ = app.emit("notify", info);
        }
    }
    *first = false;
    *last_mtime = mtime;
}

fn notification_db_loop(app: AppHandle) {
    NOTIFY_ACCESS.store(1, Ordering::Relaxed);
    let _ = app.emit("notify_access", true);
    let mut last_id: i64 = 0;
    let mut first = true;
    let mut last_mtime: Option<SystemTime> = None;
    loop {
        wpn_poll(&mut last_id, &mut first, &mut last_mtime, &app);
        thread::sleep(Duration::from_millis(1000));
    }
}

fn notification_thread(app: AppHandle) {
    thread::spawn(move || {
        ro_init();
        let listener = match UserNotificationListener::Current() {
            Ok(l) => l,
            Err(e) => {
                eprintln!("notification listener gagal: {e}, pakai database Windows");
                notification_db_loop(app);
                return;
            }
        };
        let allowed = listener
            .RequestAccessAsync()
            .and_then(|op| op.get())
            .map(|s| s == UserNotificationListenerAccessStatus::Allowed)
            .unwrap_or(false);
        if !allowed {
            // exe tanpa package identity -> baca langsung dari database notifikasi Windows
            notification_db_loop(app);
            return;
        }
        NOTIFY_ACCESS.store(1, Ordering::Relaxed);
        let _ = app.emit("notify_access", true);

        let mut seen: HashSet<u32> = HashSet::new();
        let mut first = true;
        loop {
            if let Ok(list) = listener
                .GetNotificationsAsync(NotificationKinds::Toast)
                .and_then(|op| op.get())
            {
                let mut fresh: Vec<NotifyInfo> = Vec::new();
                for n in list {
                    let Ok(id) = n.Id() else { continue };
                    if !seen.insert(id) {
                        continue;
                    }
                    if let Some(info) = read_notification(&n) {
                        fresh.push(info);
                    }
                }
                // urutan dari Windows: terbaru dulu -> proses dari yang terlama
                for info in fresh.into_iter().rev() {
                    if let Ok(mut store) = NOTIFS.lock() {
                        store.insert(0, info.clone());
                        store.truncate(20);
                    }
                    // notifikasi yang sudah ada saat migi dibuka tidak memunculkan pill
                    if !first {
                        let _ = app.emit("notify", info);
                    }
                }
                first = false;
            }
            thread::sleep(Duration::from_millis(1500));
        }
    });
}

#[tauri::command]
fn get_notifications() -> Vec<NotifyInfo> {
    NOTIFS.lock().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
fn get_notify_access() -> u8 {
    NOTIFY_ACCESS.load(Ordering::Relaxed)
}

#[tauri::command]
fn open_notification_settings(app: AppHandle) {
    let _ = app.opener().open_url("ms-settings:notifications", None::<&str>);
}

/// Frontend memanggil ini saat opsi "ikon situs" berubah.
#[tauri::command]
fn set_site_icons(enabled: bool) {
    SITE_ICONS.store(enabled, Ordering::Relaxed);
}

/// Ikon kecil untuk drag file keluar dari Shelf (dibuat sekali di folder temp).
/// Dipakai oleh tauri-plugin-drag di sisi frontend.
#[tauri::command]
fn drag_icon() -> Option<String> {
    let path = std::env::temp_dir().join("migi_drag.png");
    if !path.exists() {
        let n = 48u32;
        let mut px = vec![0u8; (n * n * 4) as usize];
        let c = (n as f32 - 1.0) / 2.0;
        for y in 0..n {
            for x in 0..n {
                let (dx, dy) = (x as f32 - c, y as f32 - c);
                if (dx * dx + dy * dy).sqrt() <= c - 1.0 {
                    let i = ((y * n + x) * 4) as usize;
                    px[i..i + 4].copy_from_slice(&[255, 255, 255, 150]);
                }
            }
        }
        let file = std::fs::File::create(&path).ok()?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), n, n);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&px).ok()?;
    }
    Some(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------
// 10) PERANGKAT BLUETOOTH + BATERAI
//     Baterai dibaca dari properti PnP Windows (perangkat klasik yang
//     melaporkan baterai lewat HFP). Jika kosong, dicoba lewat GATT
//     Battery Service (0x180F) untuk perangkat BLE.
//
//     Optimasi: query disaring di sisi WMI (PNPDeviceID LIKE 'BTH%'),
//     Get-PnpDeviceProperty dipanggil secara batch (bukan per perangkat),
//     baterai hanya dicari untuk perangkat yang tersambung, dan hasilnya
//     di-cache (TTL 60 dtk, dibatalkan otomatis oleh event Bluetooth).
// ---------------------------------------------------------------------
#[derive(Serialize, Clone)]
struct DeviceInfo {
    name: String,
    battery: Option<u8>,
    connected: bool,
    #[serde(skip)]
    addr: Option<u64>,
}

const DEVICES_PS: &str = r#"
$bt=@(Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'BTH%'" -ErrorAction SilentlyContinue)
$devs=@($bt | Where-Object { $_.PNPDeviceID -match '^(BTHENUM|BTHLE)\\DEV_' })
if($devs.Count -eq 0){'[]';exit}
$conn=@{}
Get-PnpDeviceProperty -InstanceId ($devs.PNPDeviceID) -KeyName '{83DA6326-97A6-4088-9453-A1923F573B29} 15' -ErrorAction SilentlyContinue |
  ForEach-Object { $conn[$_.InstanceId]=[bool]$_.Data }
$live=@($devs | Where-Object { $conn[$_.PNPDeviceID] })
if($live.Count -eq 0){'[]';exit}
$bat=@(Get-PnpDeviceProperty -InstanceId ($bt.PNPDeviceID) -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction SilentlyContinue |
  Where-Object { $_.Data -ne $null })
$r=@($live | ForEach-Object {
  $a=if($_.PNPDeviceID -match 'DEV_([0-9A-Fa-f]{12})'){$Matches[1]}else{''}
  $b=$null
  if($a){ $m=$bat | Where-Object { $_.InstanceId -like "*$a*" } | Select-Object -First 1; if($m){$b=$m.Data} }
  [pscustomobject]@{name=$_.Name;connected=$true;battery=$b;addr=$a}
})
if($r.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject $r -Compress}
"#;

static DEV_CACHE: Mutex<Option<(Instant, Vec<DeviceInfo>)>> = Mutex::new(None);
const DEV_TTL: Duration = Duration::from_secs(60);

fn invalidate_devices() {
    if let Ok(mut c) = DEV_CACHE.lock() {
        *c = None;
    }
}

/// Baterai perangkat BLE lewat GATT Battery Service (0x180F / karakteristik 0x2A19).
fn gatt_battery(addr: u64) -> Option<u8> {
    let dev = BluetoothLEDevice::FromBluetoothAddressAsync(addr)
        .ok()?
        .get()
        .ok()?;
    let svcs = dev
        .GetGattServicesForUuidAsync(GattServiceUuids::Battery().ok()?)
        .ok()?
        .get()
        .ok()?;
    if svcs.Status().ok()? != GattCommunicationStatus::Success {
        return None;
    }
    for svc in svcs.Services().ok()? {
        let chars = svc
            .GetCharacteristicsForUuidAsync(GattCharacteristicUuids::BatteryLevel().ok()?)
            .ok()?
            .get()
            .ok()?;
        if chars.Status().ok()? != GattCommunicationStatus::Success {
            continue;
        }
        for ch in chars.Characteristics().ok()? {
            let res = ch.ReadValueAsync().ok()?.get().ok()?;
            if res.Status().ok()? != GattCommunicationStatus::Success {
                continue;
            }
            let reader = DataReader::FromBuffer(&res.Value().ok()?).ok()?;
            return reader.ReadByte().ok().map(|b| b.min(100));
        }
    }
    None
}

#[tauri::command]
async fn get_devices() -> Vec<DeviceInfo> {
    if let Ok(c) = DEV_CACHE.lock() {
        if let Some((at, list)) = c.as_ref() {
            if at.elapsed() < DEV_TTL {
                return list.clone();
            }
        }
    }
    let list = tauri::async_runtime::spawn_blocking(|| {
        let Some(out) = run_ps(DEVICES_PS) else {
            return Vec::new();
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) else {
            return Vec::new();
        };
        let arr = match v {
            serde_json::Value::Array(a) => a,
            serde_json::Value::Null => Vec::new(),
            other => vec![other],
        };
        let mut list: Vec<DeviceInfo> = Vec::new();
        for d in arr {
            let name = d
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if name.is_empty() {
                continue;
            }
            let connected = d.get("connected").and_then(|x| x.as_bool()).unwrap_or(false);
            let battery = d
                .get("battery")
                .and_then(|x| x.as_u64())
                .map(|b| b.min(100) as u8);
            let addr = d
                .get("addr")
                .and_then(|x| x.as_str())
                .and_then(|s| u64::from_str_radix(s, 16).ok());
            // satu perangkat bisa punya beberapa node (HFP/A2DP): gabungkan
            if let Some(e) = list.iter_mut().find(|e| e.name == name) {
                e.connected |= connected;
                e.battery = e.battery.max(battery);
                e.addr = e.addr.or(addr);
            } else {
                list.push(DeviceInfo { name, battery, connected, addr });
            }
        }
        list.retain(|d| d.connected);

        // cadangan: baterai yang masih kosong dicoba lewat GATT (perangkat BLE)
        ro_init();
        for d in list.iter_mut() {
            if d.battery.is_none() {
                if let Some(a) = d.addr {
                    d.battery = gatt_battery(a);
                }
            }
        }
        list
    })
    .await
    .unwrap_or_default();

    if let Ok(mut c) = DEV_CACHE.lock() {
        *c = Some((Instant::now(), list.clone()));
    }
    list
}

// ---------------------------------------------------------------------
// 11) VOLUME (Core Audio, perangkat output default)
//     Event-driven: `IAudioEndpointVolumeCallback` dipanggil Windows hanya
//     saat volume/mute berubah, dan `IMMNotificationClient` memberi tahu
//     saat perangkat output default berganti (callback didaftarkan ulang).
//     OSD bawaan Windows disembunyikan oleh `osd_hide_thread`
//     (bisa dimatikan lewat HIDE_NATIVE_OSD).
// ---------------------------------------------------------------------
#[derive(Serialize, Clone, PartialEq, Default)]
struct VolInfo {
    level: u8,
    muted: bool,
}

fn with_volume<R>(f: impl FnOnce(&IAudioEndpointVolume) -> windows::core::Result<R>) -> Option<R> {
    com_init();
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eMultimedia).ok()?;
        let vol: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None).ok()?;
        f(&vol).ok()
    }
}

fn read_volume() -> Option<VolInfo> {
    with_volume(|v| unsafe {
        let l = v.GetMasterVolumeLevelScalar()?;
        let m = v.GetMute()?.as_bool();
        Ok(VolInfo {
            level: (l * 100.0).round().clamp(0.0, 100.0) as u8,
            muted: m,
        })
    })
}

#[tauri::command]
async fn get_volume() -> Option<VolInfo> {
    read_volume()
}

#[tauri::command]
async fn set_volume(level: u8) {
    let level = level.min(100);
    let _ = with_volume(|v| unsafe {
        v.SetMasterVolumeLevelScalar(level as f32 / 100.0, std::ptr::null())?;
        if level > 0 {
            v.SetMute(BOOL(0), std::ptr::null())?;
        }
        Ok(())
    });
}

#[tauri::command]
async fn set_mute(muted: bool) {
    let _ = with_volume(|v| unsafe {
        v.SetMute(BOOL(if muted { 1 } else { 0 }), std::ptr::null())?;
        Ok(())
    });
}

static LAST_VOL: Mutex<Option<VolInfo>> = Mutex::new(None);

/// Kirim ke UI hanya kalau nilainya benar-benar berubah.
fn push_volume(app: &AppHandle, v: VolInfo, osd: bool) {
    if let Ok(mut l) = LAST_VOL.lock() {
        if l.as_ref() == Some(&v) {
            return;
        }
        *l = Some(v.clone());
    }
    if osd {
        mark_osd();
    }
    let _ = app.emit("volume", v);
}

#[implement(IAudioEndpointVolumeCallback)]
struct VolWatch {
    app: AppHandle,
}

#[allow(non_snake_case)]
impl IAudioEndpointVolumeCallback_Impl for VolWatch_Impl {
    fn OnNotify(&self, p: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> windows::core::Result<()> {
        if p.is_null() {
            return Ok(());
        }
        let d = unsafe { &*p };
        push_volume(
            &self.app,
            VolInfo {
                level: (d.fMasterVolume * 100.0).round().clamp(0.0, 100.0) as u8,
                muted: d.bMuted.as_bool(),
            },
            true,
        );
        Ok(())
    }
}

#[implement(IMMNotificationClient)]
struct DeviceWatch {
    tx: mpsc::Sender<()>,
}

#[allow(non_snake_case)]
impl IMMNotificationClient_Impl for DeviceWatch_Impl {
    fn OnDeviceStateChanged(&self, _: &PCWSTR, _: DEVICE_STATE) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnDeviceAdded(&self, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnDeviceRemoved(&self, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnDefaultDeviceChanged(
        &self,
        flow: EDataFlow,
        role: ERole,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        if flow == eRender && role == eMultimedia {
            let _ = self.tx.send(());
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _: &PCWSTR, _: &PROPERTYKEY) -> windows::core::Result<()> {
        Ok(())
    }
}

fn volume_thread(app: AppHandle) {
    thread::spawn(move || unsafe {
        com_init();
        let (tx, rx) = mpsc::channel::<()>();
        let en: IMMDeviceEnumerator = match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(e) => e,
            Err(_) => return,
        };
        let notif: IMMNotificationClient = DeviceWatch { tx }.into();
        let _ = en.RegisterEndpointNotificationCallback(&notif);
        let cb: IAudioEndpointVolumeCallback = VolWatch { app: app.clone() }.into();
        let mut cur: Option<IAudioEndpointVolume> = None;

        loop {
            if let Some(old) = cur.take() {
                let _ = old.UnregisterControlChangeNotify(&cb);
            }
            cur = en
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .ok()
                .and_then(|d| d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok())
                .and_then(|v| v.RegisterControlChangeNotify(&cb).ok().map(|_| v));

            // nilai awal / setelah ganti perangkat (tanpa memicu penyembunyian OSD Windows)
            if let Some(v) = &cur {
                if let (Ok(l), Ok(m)) = (v.GetMasterVolumeLevelScalar(), v.GetMute()) {
                    push_volume(
                        &app,
                        VolInfo {
                            level: (l * 100.0).round().clamp(0.0, 100.0) as u8,
                            muted: m.as_bool(),
                        },
                        false,
                    );
                }
                // tidur total sampai perangkat default berganti
                if rx.recv().is_err() {
                    break;
                }
            } else {
                // belum ada perangkat output: coba lagi tiap 5 detik
                let _ = rx.recv_timeout(Duration::from_secs(5));
            }
            thread::sleep(Duration::from_millis(200)); // debounce
            while rx.try_recv().is_ok() {}
        }
    });
}

// ---------------------------------------------------------------------
// 12) BRIGHTNESS (WMI; hanya layar internal laptop)
// ---------------------------------------------------------------------
#[tauri::command]
async fn get_brightness() -> Option<u8> {
    tauri::async_runtime::spawn_blocking(|| {
        run_ps(
            "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentBrightness",
        )
        .and_then(|s| s.trim().parse::<u8>().ok())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn set_brightness(level: u8) {
    let level = level.clamp(1, 100);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        run_ps(&format!(
            "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=[uint32]1;Brightness=[byte]{level}}} | Out-Null"
        ))
    })
    .await;
}

// ---------------------------------------------------------------------
// 12b) OSD: pantau brightness, sembunyikan OSD bawaan Windows
//      (pemantauan volume ada di bagian 11)
// ---------------------------------------------------------------------

/// Satu proses PowerShell yang hidup terus dan menunggu event WMI
/// `WmiMonitorBrightnessEvent` (hanya menembak saat brightness berubah).
/// Sebagai pengaman untuk laptop yang tidak memicu event, ada resync
/// tiap ~30 detik. Berhenti sendiri jika migi sudah tertutup.
fn brightness_thread(app: AppHandle) {
    thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};

        const SCRIPT: &str = r#"
$l=-1
$q="SELECT * FROM WmiMonitorBrightnessEvent"
Register-CimIndicationEvent -Namespace root/WMI -Query $q -SourceIdentifier migiBr | Out-Null
$n=0
while($true){
  if(-not (Get-Process -Id __PID__ -ErrorAction SilentlyContinue)){exit}
  $e=Wait-Event -SourceIdentifier migiBr -Timeout 5
  $b=$null
  if($e){
    $b=$e.SourceEventArgs.NewEvent.Brightness
    Remove-Event -EventIdentifier $e.EventIdentifier
    $n=0
  } else {
    $n++
    if($n -ge 6 -or $l -eq -1){
      $n=0
      $b=(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentBrightness
    }
  }
  if($null -ne $b -and $b -ne $l){ $l=$b; [Console]::Out.WriteLine($b); [Console]::Out.Flush() }
}
"#;
        let script = SCRIPT.replace("__PID__", &std::process::id().to_string());

        loop {
            let child = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(PS_FLAGS)
                .spawn();
            if let Ok(mut child) = child {
                if let Some(out) = child.stdout.take() {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        if let Ok(v) = line.trim().parse::<u8>() {
                            mark_osd();
                            let _ = app.emit("brightness", v);
                        }
                    }
                }
                let _ = child.wait();
            }
            thread::sleep(Duration::from_secs(5));
        }
    });
}

/// Callback EnumWindows: sembunyikan jendela OSD Windows (kecil, class shell).
unsafe extern "system" fn hide_osd_cb(hwnd: HWND, _l: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        let cls = class_of(hwnd);
        if cls == "NativeHWNDHost" || cls == "XamlExplorerHostIslandWindow" {
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                let (w, h) = (r.right - r.left, r.bottom - r.top);
                // OSD berukuran kecil; flyout besar (Quick Settings dll.) tidak disentuh
                if w > 0 && w <= 700 && h > 0 && h <= 250 {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                }
            }
        }
    }
    BOOL(1)
}

/// Hanya aktif ~1,5 detik setelah volume/brightness berubah (lihat `mark_osd`),
/// jadi flyout taskbar yang dibuka manual tidak ikut tersembunyi.
fn osd_hide_thread() {
    if !HIDE_NATIVE_OSD {
        return;
    }
    thread::spawn(|| loop {
        if now_ms() < OSD_UNTIL.load(Ordering::Relaxed) {
            unsafe {
                let _ = EnumWindows(Some(hide_osd_cb), LPARAM(0));
            }
            thread::sleep(Duration::from_millis(20));
        } else {
            thread::sleep(Duration::from_millis(100));
        }
    });
}

// ---------------------------------------------------------------------
// 13) MAIN
// ---------------------------------------------------------------------
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .invoke_handler(tauri::generate_handler![
            media_toggle,
            media_next,
            media_prev,
            media_seek,
            fetch_lyrics,
            get_power,
            clipboard_write,
            open_path,
            place_notch,
            set_hot,
            show_settings,
            close_settings,
            open_link,
            get_autostart,
            set_autostart,
            sync_tray,
            set_tray_lang,
            get_notifications,
            get_notify_access,
            open_notification_settings,
            get_devices,
            get_volume,
            set_volume,
            set_mute,
            get_brightness,
            set_brightness,
            set_site_icons,
            drag_icon,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            media_thread(handle.clone());
            monitor_thread(handle.clone());
            hover_thread(handle.clone());
            notification_thread(handle.clone());
            volume_thread(handle.clone());
            brightness_thread(handle.clone());
            osd_hide_thread();
            bluetooth_watch(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running migi");
}