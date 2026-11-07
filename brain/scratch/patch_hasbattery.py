
# Script untuk patch has_battery di lib.rs
import re

with open(r"e:\Project Code 2026\migi\src-tauri\src\lib.rs", "r", encoding="utf-8") as f:
    content = f.read()

old = '''// Command: cek apakah device punya baterai (laptop) atau tidak (PC desktop).
// Pakai WMI Win32_Battery — kalau kosong = tidak ada baterai = PC desktop.
#[tauri::command]
fn has_battery() -> bool {
    #[cfg(target_os = "windows")]
    {
        use serde::Deserialize;
        use wmi::{COMLibrary, WMIConnection};
        #[derive(Deserialize)]
        #[serde(rename = "Win32_Battery")]
        #[allow(dead_code, non_snake_case)]
        struct Battery { Name: String }
        let Ok(com) = COMLibrary::new() else { return false; };
        let Ok(wmi) = WMIConnection::new(com) else { return false; };
        let result: Result<Vec<Battery>, _> = wmi.query();
        result.ok().map(|v| !v.is_empty()).unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    { false }
}'''

new = '''// Command: cek apakah device punya baterai (laptop) atau tidak (PC desktop).
// Pakai WMI Win32_Battery — kalau kosong = tidak ada baterai = PC desktop.
// assume_init() karena COM sudah diinit oleh Tauri di thread command handler.
#[tauri::command]
fn has_battery() -> bool {
    #[cfg(target_os = "windows")]
    {
        use serde::Deserialize;
        use wmi::{COMLibrary, WMIConnection};
        #[derive(Deserialize)]
        #[serde(rename = "Win32_Battery")]
        #[allow(dead_code, non_snake_case)]
        struct Battery { Name: String }
        // assume_init: COM sudah diinit oleh Tauri — tidak perlu init ulang
        let com = unsafe { COMLibrary::assume_init() };
        let Ok(wmi) = WMIConnection::new(com) else {
            eprintln!("[Migi] has_battery: WMI gagal");
            return false;
        };
        let result: Result<Vec<Battery>, _> = wmi.query();
        match result {
            Ok(v) => { println!("[Migi] has_battery: {} baterai", v.len()); !v.is_empty() }
            Err(e) => { eprintln!("[Migi] has_battery: query gagal: {e}"); false }
        }
    }
    #[cfg(not(target_os = "windows"))]
    { false }
}'''

if old in content:
    content = content.replace(old, new)
    with open(r"e:\Project Code 2026\migi\src-tauri\src\lib.rs", "w", encoding="utf-8") as f:
        f.write(content)
    print("PATCHED OK")
else:
    print("NOT FOUND — trying line search")
    for i, line in enumerate(content.splitlines(), 1):
        if "COMLibrary::new()" in line:
            print(f"  line {i}: {line.strip()}")

