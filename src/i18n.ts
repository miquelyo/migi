export type Lang = "id" | "en";
export const LANGS: { v: Lang; l: string }[] = [
  { v: "id", l: "Bahasa Indonesia" },
  { v: "en", l: "English" },
];
export const detectLang = (): Lang =>
  (navigator.language || "").toLowerCase().startsWith("id") ? "id" : "en";
export const locale = (l: Lang) => (l === "id" ? "id-ID" : "en-US");

const id = {
  // musik & lirik
  lyrics: "Lirik", lyricsTitle: "Lirik Lagu", lyricsSearching: "Mencari lirik…",
  lyricsNone: "Lirik tidak ditemukan", lyricsUnsynced: "Lirik tanpa sinkronisasi",
  prev: "Sebelumnya", next: "Berikutnya", play: "Putar", pause: "Jeda",
  mute: "Bisukan", volume: "Volume", notPlaying: "Tidak ada musik",
  restingLabel: "Migi sedang istirahat", reminder: "Pengingat", settings: "Pengaturan",
  prevPage: "Halaman sebelumnya", nextPage: "Halaman berikutnya",
  pageMusic: "Musik", pageDashboard: "Dashboard", pageWater: "Pengingat Air",
  pageShelf: "Shelf", pageClipboard: "Clipboard",
  agoNow: "sekarang", agoMin: "{n} mnt", agoHour: "{n} jam", agoDay: "{n} hr",
  // dashboard
  dashNotifs: "Notifikasi", clear: "Hapus", accessOff: "Akses belum aktif",
  openSettings: "Buka pengaturan", noNotifs: "Belum ada notifikasi",
  noNotifsSub: "Yang terbaru muncul di sini", devices: "Perangkat", thisPc: "PC ini",
  // water
  waterGoal: "Target", waterInterval: "Interval", unitMin: "{n} mnt", done: "Selesai",
  today: "Hari ini", waterNext: "Berikut", off: "mati", drink: "Minum",
  goalDown: "Kurangi target", goalUp: "Tambah target",
  intDown: "Kurangi interval", intUp: "Tambah interval",
  // shelf & clipboard
  shelfDrop: "Letakkan file di sini", shelfHint: "Seret keluar kapan saja · klik untuk membuka",
  fileCount: "{n} file", clearAll: "Hapus semua", clipEmpty: "Belum ada yang disalin",
  clipEmptySub: "Teks yang Anda salin akan muncul di sini",
  removeShelf: "Hapus dari Shelf", removeClip: "Hapus dari Clipboard",
  // popup
  waterPillTitle: "Waktunya minum air",
  chargingTitle: "Pengisian daya", chargingSub: "Pengisi daya terhubung",
  chargerOffTitle: "Pengisi daya dicabut", chargerOffSub: "Berjalan dengan baterai",
  lowTitle: "Baterai lemah", lowSub: "Segera colok pengisi daya",
  fullTitle: "Baterai penuh", fullSub: "Pengisi daya bisa dicabut",
  btDevice: "Perangkat Bluetooth", btConnected: "Tersambung", btDisconnected: "Terputus",
  // pengaturan
  secGeneral: "Umum", secMusic: "Musik & lirik", secWater: "Air", secShelf: "Shelf",
  secHud: "HUD & popup", secAbout: "Tentang",
  cardStartup: "Startup", autostart: "Jalankan saat Windows menyala",
  cardNotch: "Notch", minimal: "Notch minimal", minimalSub: "Pil yang lebih kecil saat tidak ada musik",
  mascot: "Maskot Migi", mascotSub: "Teman kecil yang tinggal di notch saat PC diam",
  cardFullscreen: "Layar penuh", hideFs: "Sembunyikan di layar penuh",
  hideFsSub: "Game, video, dan slide yang memenuhi layar",
  cardLanguage: "Bahasa", language: "Bahasa antarmuka",
  cardLyrics: "Lirik", showLyrics: "Tampilkan lirik",
  showLyricsSub: "Dari LRCLIB, database lirik kontribusi komunitas",
  lyricOffset: "Offset lirik",
  lyricOffsetSub: "Lirik terasa telat: naikkan nilainya. Terlalu cepat: turunkan.",
  cardReminder: "Pengingat", drinkReminder: "Pengingat minum", drinkReminderSub: "Popup di notch sesuai interval",
  cardPlan: "Rencana", dailyGoal: "Target harian", cupSize: "Ukuran gelas",
  activeFrom: "Aktif mulai", activeUntil: "Aktif sampai",
  todayProgress: "Progres hari ini", reset: "Reset",
  cardShelf: "Shelf", emptyOnStart: "Mulai dengan Shelf kosong",
  emptyOnStartSub: "File dari sesi terakhir dibersihkan saat Migi dibuka",
  cardClipboard: "Riwayat clipboard", clipHistorySub: "Teks yang Anda salin, siap ditempel lagi dari Shelf",
  keepUpTo: "Simpan hingga", items: "{n} item", remember: "Ingat setelah restart",
  rememberSub: "Hanya disimpan di PC ini",
  cardIndicators: "Indikator", brightness: "Kecerahan", cardPopups: "Popup",
  charger: "Pengisi daya & baterai", bluetooth: "Bluetooth",
  siteIcons: "Ikon situs di notifikasi",
  siteIconsSub: "Ikon YouTube, Gmail, dll dari layanan favicon Google. Hanya nama domain yang dikirim.",
  lowLevel: "Batas baterai lemah",
  cardTest: "Uji tampilan", testNotif: "Notifikasi", testNotifBody: "Halo dari Migi!",
  testBt: "Bluetooth", testBtOff: "BT terputus", testCharger: "Charger",
  testUnplug: "Dicabut", testLow: "Baterai lemah", testFull: "Penuh",
  version: "Versi {v}", tagline: "Notch yang hidup untuk Windows", cardInfo: "Info",
  madeBy: "Dibuat oleh", close: "Tutup", decrease: "Kurangi", increase: "Tambah",
  // pembaruan
  cardUpdate: "Pembaruan", updCheck: "Periksa pembaruan", updInstall: "Perbarui sekarang",
  updChecking: "Memeriksa…", updNone: "Sudah versi terbaru", updAvailable: "Versi {v} tersedia",
  updDownloading: "Mengunduh… {n}%", updError: "Gagal memeriksa pembaruan",
  updHint: "Buka Pengaturan › Tentang untuk memperbarui",
};

type Key = keyof typeof id;

const en: Record<Key, string> = {
  lyrics: "Lyrics", lyricsTitle: "Song lyrics", lyricsSearching: "Searching lyrics…",
  lyricsNone: "Lyrics not found", lyricsUnsynced: "Lyrics aren't synced",
  prev: "Previous", next: "Next", play: "Play", pause: "Pause",
  mute: "Mute", volume: "Volume", notPlaying: "Not playing",
  restingLabel: "Migi is resting", reminder: "Reminder", settings: "Settings",
  prevPage: "Previous page", nextPage: "Next page",
  pageMusic: "Music", pageDashboard: "Dashboard", pageWater: "Water Reminder",
  pageShelf: "Shelf", pageClipboard: "Clipboard",
  agoNow: "now", agoMin: "{n} min", agoHour: "{n} h", agoDay: "{n} d",
  dashNotifs: "Notifications", clear: "Clear", accessOff: "Access not enabled",
  openSettings: "Open settings", noNotifs: "No notifications yet",
  noNotifsSub: "The latest ones appear here", devices: "Devices", thisPc: "This PC",
  waterGoal: "Goal", waterInterval: "Interval", unitMin: "{n} min", done: "Done",
  today: "Today", waterNext: "Next", off: "off", drink: "Drink",
  goalDown: "Decrease goal", goalUp: "Increase goal",
  intDown: "Decrease interval", intUp: "Increase interval",
  shelfDrop: "Drop files here", shelfHint: "Drag out anytime · click to open",
  fileCount: "{n} files", clearAll: "Clear all", clipEmpty: "Nothing copied yet",
  clipEmptySub: "Text you copy will appear here",
  removeShelf: "Remove from Shelf", removeClip: "Remove from Clipboard",
  waterPillTitle: "Time to drink water",
  chargingTitle: "Charging", chargingSub: "Charger connected",
  chargerOffTitle: "Charger unplugged", chargerOffSub: "Running on battery",
  lowTitle: "Low battery", lowSub: "Plug in your charger soon",
  fullTitle: "Battery full", fullSub: "You can unplug the charger",
  btDevice: "Bluetooth device", btConnected: "Connected", btDisconnected: "Disconnected",
  secGeneral: "General", secMusic: "Music & lyrics", secWater: "Water", secShelf: "Shelf",
  secHud: "HUD & popups", secAbout: "About",
  cardStartup: "Startup", autostart: "Launch at Windows startup",
  cardNotch: "Notch", minimal: "Minimal notch", minimalSub: "A smaller pill when no music is playing",
  mascot: "Migi mascot", mascotSub: "A little friend living in the notch while the PC is idle",
  cardFullscreen: "Fullscreen", hideFs: "Hide in fullscreen",
  hideFsSub: "Games, videos and slides that fill the screen",
  cardLanguage: "Language", language: "Interface language",
  cardLyrics: "Lyrics", showLyrics: "Show lyrics",
  showLyricsSub: "From LRCLIB, a community-contributed lyrics database",
  lyricOffset: "Lyrics offset",
  lyricOffsetSub: "Lyrics feel late: increase it. Too early: decrease it.",
  cardReminder: "Reminder", drinkReminder: "Drink reminder", drinkReminderSub: "Popup in the notch at each interval",
  cardPlan: "Plan", dailyGoal: "Daily goal", cupSize: "Cup size",
  activeFrom: "Active from", activeUntil: "Active until",
  todayProgress: "Today's progress", reset: "Reset",
  cardShelf: "Shelf", emptyOnStart: "Start with an empty Shelf",
  emptyOnStartSub: "Files from the last session are cleared when Migi starts",
  cardClipboard: "Clipboard history", clipHistorySub: "Text you copied, ready to paste again from Shelf",
  keepUpTo: "Keep up to", items: "{n} items", remember: "Remember after restart",
  rememberSub: "Stored on this PC only",
  cardIndicators: "Indicators", brightness: "Brightness", cardPopups: "Popups",
  charger: "Charger & battery", bluetooth: "Bluetooth",
  siteIcons: "Site icons in notifications",
  siteIconsSub: "YouTube, Gmail, etc. icons from Google's favicon service. Only the domain name is sent.",
  lowLevel: "Low battery level",
  cardTest: "Test display", testNotif: "Notification", testNotifBody: "Hello from Migi!",
  testBt: "Bluetooth", testBtOff: "BT disconnected", testCharger: "Charger",
  testUnplug: "Unplugged", testLow: "Low battery", testFull: "Full",
  version: "Version {v}", tagline: "A living notch for Windows", cardInfo: "Info",
  madeBy: "Made by", close: "Close", decrease: "Decrease", increase: "Increase",
  cardUpdate: "Updates", updCheck: "Check for updates", updInstall: "Update now",
  updChecking: "Checking…", updNone: "You're up to date", updAvailable: "Version {v} available",
  updDownloading: "Downloading… {n}%", updError: "Couldn't check for updates",
  updHint: "Open Settings › About to update",
};

export type T = (k: Key, v?: Record<string, string | number>) => string;

export const makeT = (lang: Lang): T => {
  const d: Record<Key, string> = lang === "id" ? id : en;
  return (k, v) => {
    let s = d[k];
    if (v) for (const x in v) s = s.replace(`{${x}}`, String(v[x]));
    return s;
  };
};