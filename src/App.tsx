import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { CFG_KEY, loadCfg, saveCfg, type Cfg } from "./config";
import { makeT, locale, type Lang, type T } from "./i18n";

/* ------------------------------------------------------------------ */
/* Tipe & konstanta                                                    */
/* ------------------------------------------------------------------ */
type Media = {
  active: boolean;
  title: string;
  artist: string;
  playing: boolean;
  position: number;
  duration: number;
  art: string | null;
};
type Power = { hasBattery: boolean; charging: boolean; percent: number };
type Pill = {
  kind: "notify" | "bluetooth" | "charging" | "battery" | "water";
  tone?: "warn" | "ok" | "off"; // warna ikon (merah / hijau / abu-abu)
  label?: string;
  title: string;
  sub: string;
  right?: string;
  icon?: string | null; // logo besar (ikon situs, atau logo aplikasi)
  badge?: string | null; // logo kecil di pojok (logo browser)
};
type ShelfItem = { path: string; name: string };
type Line = { t: number; text: string };
type Page = "music" | "dashboard" | "water" | "shelf" | "clipboard";
type Mode = "mini" | "rest" | "idle" | "pill" | "open" | "tabs" | "lyrics" | "bar" | "osd";
type Osd = { kind: "volume" | "brightness"; value: number; muted?: boolean };
type LyricsState = { key: string; lines: Line[] | null; plain: string[] | null; loading: boolean };
type NotifItem = {
  id: number;
  app: string;
  title: string;
  body: string;
  at: number;
  icon?: string | null; // logo aplikasi pengirim (dari Windows)
  site?: string | null; // domain situs (notifikasi dari browser)
  siteIcon?: string | null; // ikon situs (YouTube, Gmail, dll)
};
type DeviceInfo = { name: string; battery: number | null; connected: boolean };
type VolInfo = { level: number; muted: boolean };

const PAGES: Page[] = ["music", "dashboard", "water", "shelf", "clipboard"];

/* Ukuran notch proporsional, compact, dan modern.
   Semua halaman (termasuk Dashboard) memakai ukuran "open" yang sama. */
const SIZES: Record<Mode, { w: number; h: number }> = {
  mini: { w: 40, h: 3 },
  rest: { w: 151, h: 30 },
  idle: { w: 151, h: 30 },
  pill: { w: 320, h: 64 },
  open: { w: 420, h: 140 },
  tabs: { w: 420, h: 160 }, // open + tab bar ikon (saat titik-titik di-hover)
  lyrics: { w: 520, h: 140 },
  bar: { w: 360, h: 30 }, // bar lirik satu baris (tetap tampil walau ada app maximize)
  osd: { w: 320, h: 40 }, // OSD volume / brightness (pengganti OSD bawaan Windows)
};

/* Jendela native TIDAK PERNAH di-resize: ukurannya tetap sebesar mode terbesar.
   Hanya notch (CSS) yang beranimasi. Bentuk notch digambar penuh oleh CSS
   (anti-aliased); area jendela di luar notch transparan dan dibuat click-through
   oleh Rust (set_ignore_cursor_events) selama kursor tidak berada di zona notch. */
const WINDOW_MAX = { w: 520, h: 170 };

/* Zona hover (dipantau Rust lewat posisi kursor). Mode mini diberi zona lebih besar. */
const hitRect = (m: Mode) => (m === "mini" ? { w: 84, h: 24 } : SIZES[m]);

const DEFAULT_ART: [string, string] = ["47,98,255", "47,98,255"];
const BAR_MIN = 170;
const BAR_MAX = 500;
let _measureCtx: CanvasRenderingContext2D | null = null;
/* Lebar bar lirik mengikuti panjang teks: pendek -> bar kecil, panjang -> bar melebar (maks BAR_MAX) */
function barWidthFor(text: string): number {
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  let tw = text.length * 7.5;
  if (_measureCtx) {
    _measureCtx.font = '700 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
    tw = _measureCtx.measureText(text).width;
  }
  return Math.max(BAR_MIN, Math.min(BAR_MAX, Math.ceil(tw) + 38 * 2 + 6));
}

const ANIM_MS = 300;
const PILL_MS = 4000;
const OSD_MS = 1800; // lama OSD volume/brightness tampil
const MINI_TO_OPEN_MS = 250; // jeda tampil idle sebelum membuka dari mode mini
const VOL_PANEL_MS = 3000; // panel volume di player menutup sendiri setelah sekian ms
const EMPTY_MEDIA: Media = {
  active: false,
  title: "",
  artist: "",
  playing: false,
  position: 0,
  duration: 0,
  art: null,
};

/* ------------------------------------------------------------------ */
/* Fungsi bantu                                                        */
/* ------------------------------------------------------------------ */
async function placeWindow(s: { w: number; h: number }) {
  try {
    try {
      await invoke("place_notch", { w: s.w, h: s.h });
      return;
    } catch {
      // fallback jika belum ter-compile
    }
    const win = getCurrentWindow();
    // Beri ruang 12px di kiri dan 12px di kanan untuk telinga (ear)
    const winW = s.w + 24;
    const targetX = Math.round((window.screen.width - winW) / 2);
    await Promise.all([
      win.setSize(new LogicalSize(winW, s.h)),
      win.setPosition(new LogicalPosition(targetX, 0)),
    ]);
  } catch (err) {
    console.error("placeWindow:", err);
  }
}

const fmtClock = (d: Date) =>
  d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDate = (d: Date, lang: Lang) => {
  const loc = locale(lang);
  const weekday = d.toLocaleDateString(loc, { weekday: "short" });
  const month = d.toLocaleDateString(loc, { month: "short" });
  return `${weekday} ${d.getDate()} ${month} ${d.getFullYear()}`;
};
const fmtTime = (s: number) => {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function parseLrc(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m && m[3].trim() !== "") {
      out.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text: m[3] });
    }
  }
  return out;
}

/* Lirik tanpa timestamp: pecah per baris, buang baris kosong berurutan */
function parsePlain(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (s === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(s);
  }
  return out;
}

function readShelf(): ShelfItem[] {
  try {
    return JSON.parse(localStorage.getItem("migi.shelf") ?? "[]");
  } catch {
    return [];
  }
}

function readClips(): string[] {
  try {
    return JSON.parse(localStorage.getItem("migi.clips") ?? "[]");
  } catch {
    return [];
  }
}

/* ---- Water Reminder: disimpan di localStorage ("migi.water"), reset otomatis tiap hari ---- */
type Water = { date: string; ml: number; goal: number; interval: number; bell: boolean; next: number };
const dayKey = (d = new Date()) => d.toLocaleDateString("en-CA");
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function freshWater(prev?: Partial<Water>): Water {
  const interval = prev?.interval ?? 60;
  return {
    date: dayKey(),
    ml: 0,
    goal: prev?.goal ?? 1500,
    interval,
    bell: prev?.bell ?? true,
    next: Date.now() + interval * 60000,
  };
}
function readWater(): Water {
  try {
    const w = JSON.parse(localStorage.getItem("migi.water") ?? "null") as Water | null;
    if (w && w.date === dayKey()) return w;
    return freshWater(w ?? undefined);
  } catch {
    return freshWater();
  }
}

function useTauriEvent<T>(name: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    listen<T>(name, (e) => ref.current(e.payload))
      .then((f) => (cancelled ? f() : (un = f)))
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
    };
  }, [name]);
}

/* ------------------------------------------------------------------ */
/* Ikon kecil                                                          */
/* ------------------------------------------------------------------ */
const Svg = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {children}
  </svg>
);
const IconPlay = () => <Svg size={20}><path d="M8 5.5v13l11-6.5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></Svg>;
const IconPause = () => <Svg size={20}><rect x="6" y="4.5" width="4" height="15" rx="1.3" /><rect x="14" y="4.5" width="4" height="15" rx="1.3" /></Svg>;
const IconPrev = () => <Svg size={20}><path d="M11.5 6.2v11.6L3.2 12zM20.8 6.2v11.6L12.5 12z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></Svg>;
const IconNext = () => <Svg size={20}><path d="M12.5 6.2v11.6L20.8 12zM3.2 6.2v11.6L11.5 12z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></Svg>;
const IconLyrics = () => (
  <Svg size={18}>
    <path d="M5 4h14a2 2 0 012 2v9a2 2 0 01-2 2h-8l-4.5 3.5V17H5a2 2 0 01-2-2V6a2 2 0 012-2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="9" cy="10" r="1.4" />
    <circle cx="14.5" cy="10" r="1.4" />
    <path d="M10.3 10.2c0 1.3-.5 2-1.5 2.4M15.8 10.2c0 1.3-.5 2-1.5 2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </Svg>
);
const IconMusicNote = () => (
  <Svg size={30}>
    <path d="M9 7.2l10-2v3l-10 2z" />
    <path d="M9 8v9.5M19 6v9.5" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="6.5" cy="17.5" r="2.7" />
    <circle cx="16.5" cy="15.5" r="2.7" />
  </Svg>
);
const IconChevron = ({ dir }: { dir: "left" | "right" }) => (
  <Svg size={12}>
    <path d={dir === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
const IconChat = () => <Svg size={15}><path d="M4 4h16a1 1 0 011 1v11a1 1 0 01-1 1H9l-5 4V5a1 1 0 011-1z" /></Svg>;
const IconClip = () => <Svg size={15}><path d="M9 3h6l1 2h3v16H5V5h3zm1 2v2h4V5z" /></Svg>;
const IconBolt = () => <Svg size={20}><path d="M13 2L5 14h6l-1 8 8-12h-6z" /></Svg>;
const IconBattery = () => (
  <Svg size={20}>
    <path d="M3 8h15a1 1 0 011 1v1h2v4h-2v1a1 1 0 01-1 1H3a1 1 0 01-1-1V9a1 1 0 011-1z" fill="none" stroke="currentColor" strokeWidth="2" />
    <rect x="5" y="10.5" width="4" height="3" rx="0.6" />
  </Svg>
);
const IconBt = () => (
  <Svg size={20}>
    <path d="M12 2l6 5-4.5 4.5L18 16l-6 6v-8.5l-4 4-1.5-1.5L11 12 6.5 7.5 8 6l4 4zm2 3.8V9l1.7-1.6zm0 8.4v3.2l1.7-1.6z" />
  </Svg>
);
const IconHeadphones = () => (
  <Svg size={20}>
    <path d="M12 3a9 9 0 00-9 9v7a2 2 0 002 2h2v-8H5v-1a7 7 0 0114 0v1h-2v8h2a2 2 0 002-2v-7a9 9 0 00-9-9z" />
  </Svg>
);
const IconVolume = () => (
  <Svg size={18}>
    <path d="M3 9.5v5h3.8L12 19V5L6.8 9.5z" />
    <path d="M15.5 8.5a5 5 0 010 7M18.2 6a8.8 8.8 0 010 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </Svg>
);
/* Ikon tab bar bawah */
const IconNote = () => <Svg size={15}><path d="M9 3v11.3A3.5 3.5 0 1010 17V8h6V3z" /></Svg>;
const IconTray = () => (
  <Svg size={16}>
    <path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 2h6l1-2h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  </Svg>
);
const IconGear = () => (
  <Svg size={16}>
    <path d="M19.4 13a7.7 7.7 0 000-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 000 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 001.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 001.7-1l2.4 1 2-3.4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </Svg>
);

const IconDrop = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}><path d="M12 2.5c3.5 4.4 6 7.5 6 10.6a6 6 0 01-12 0c0-3.1 2.5-6.2 6-10.6z" /></Svg>
);
const IconBell = () => <Svg size={13}><path d="M12 3a6 6 0 00-6 6v4l-2 3h16l-2-3V9a6 6 0 00-6-6zm-2 15a2 2 0 004 0z" /></Svg>;
const IconSliders = () => (
  <Svg size={14}>
    <path d="M3 8h10M19 8h2M3 16h2M11 16h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="16" cy="8" r="2.6" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="8" cy="16" r="2.6" fill="none" stroke="currentColor" strokeWidth="2" />
  </Svg>
);
const IconTrayBig = () => (
  <Svg size={30}>
    <path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 2h6l1-2h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M12 1.5v6M9.3 5.2L12 8l2.7-2.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const fmtAgo = (at: number, nowMs: number, t: T) => {
  const sec = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (sec < 60) return t("agoNow");
  const m = Math.floor(sec / 60);
  if (m < 60) return t("agoMin", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("agoHour", { n: h });
  return t("agoDay", { n: Math.floor(h / 24) });
};

const IconDash = () => (
  <Svg size={15}>
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
    <rect x="13" y="13" width="8" height="8" rx="2" />
  </Svg>
);
const IconMute = () => (
  <Svg size={18}>
    <path d="M3 9.5v5h3.8L12 19V5L6.8 9.5z" />
    <path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </Svg>
);
const IconSun = () => (
  <Svg size={18}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </Svg>
);
const IconLaptop = () => (
  <Svg size={16}>
    <path d="M5 5h14a1 1 0 011 1v9H4V6a1 1 0 011-1zM2 17h20v1.5a1 1 0 01-1 1H3a1 1 0 01-1-1z" />
  </Svg>
);
const IconSpeaker = () => (
  <Svg size={16}>
    <rect x="5.5" y="2.5" width="13" height="19" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="12" cy="14.5" r="3.4" />
    <circle cx="12" cy="7.2" r="1.4" />
  </Svg>
);
const IconEarbuds = () => (
  <Svg size={16}>
    <rect x="3.5" y="3" width="6.5" height="11" rx="3.2" />
    <rect x="14" y="3" width="6.5" height="11" rx="3.2" />
    <rect x="6" y="12.5" width="1.6" height="8" rx="0.8" />
    <rect x="16.4" y="12.5" width="1.6" height="8" rx="0.8" />
  </Svg>
);
function DeviceIcon({ name }: { name: string }) {
  if (/buds|airpods|tws|earbud|pods|wf-|ear\s?\(/i.test(name)) return <IconEarbuds />;
  if (/headphone|headset|wh-|arctis|momentum|over.?ear/i.test(name)) return <IconHeadphones />;
  if (/speaker|jbl|soundbar|boom|flip|charge|bose|sonos|marshall|soundcore/i.test(name)) return <IconSpeaker />;
  return <IconBt />;
}

/* Indikator baterai kecil (merah jika <= 20%) */
function Battery({ pct, charging }: { pct: number | null; charging?: boolean }) {
  if (pct == null) return <span className="bat none">–</span>;
  const low = pct <= 20 && !charging;
  return (
    <span className={low ? "bat low" : charging ? "bat chg" : "bat"}>
      <span className="bat-body"><i style={{ width: `${pct}%` }} /></span>
      <b>{pct}%</b>
    </span>
  );
}

/* Slider seret (volume / brightness) */
function Slider({ value, onChange, disabled, accent = "#fff" }: {
  value: number; onChange: (v: number) => void; disabled?: boolean; accent?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const apply = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v = clamp(Math.round(((e.clientX - r.left) / r.width) * 100), 0, 100);
    if (v !== value) onChange(v);
  };
  return (
    <div
      ref={ref}
      className={disabled ? "slider off" : "slider"}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) apply(e);
      }}
    >
      <i style={{ width: `${value}%`, background: accent }} />
    </div>
  );
}

/* Telinga lengkungan cekung di sudut kiri & kanan atas notch */
const Ear = ({ side }: { side: "left" | "right" }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    className={`ear ${side}`}
    aria-hidden="true"
  >
    <path
      d={
        side === "left"
          ? "M0 0 H12 V12 A12 12 0 0 0 0 0 Z"
          : "M0 0 H12 A12 12 0 0 0 0 12 V0 Z"
      }
      fill="#000"
    />
  </svg>
);

function Bars({ playing }: { playing: boolean }) {
  return (
    <span className={playing ? "bars playing" : "bars"} aria-hidden="true">
      <i /><i /><i /><i /><i />
    </span>
  );
}

/* Ring baterai. Ikon petir di tengah HANYA muncul saat charger dicolok. */
function Ring({ percent, charging, size = 15 }: { percent: number; charging: boolean; size?: number }) {
  const stroke = size >= 20 ? 2.6 : size <= 14 ? 2.0 : 2.4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, percent || 100));
  const s = (size * 0.58) / 24; // skala petir relatif ke ukuran ring
  const o = size / 2 - 12 * s; // offset supaya petir berada di tengah
  return (
    <svg className={charging ? "ring charging" : "ring"} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#13331b" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#09ff00ff"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${(c * p) / 100} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {charging && (
        <path
          d="M13 2L5 14h6l-1 8 8-12h-6z"
          fill="#09ff00"
          transform={`translate(${o} ${o}) scale(${s})`}
        />
      )}
    </svg>
  );
}

/* Gauge persen air (busur 270°, mulai dari kiri bawah) */
function WaterGauge({ pct }: { pct: number }) {
  const size = 84, stroke = 7, r = (size - stroke) / 2 - 3, cx = size / 2, c = 2 * Math.PI * r;
  const arc = 0.75 * c;
  const p = clamp(pct, 0, 100) / 100;
  const a = (135 * Math.PI) / 180;
  return (
    <div className="gauge">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <g transform={`rotate(135 ${cx} ${cx})`}>
          <circle cx={cx} cy={cx} r={r} fill="none" stroke="#14283d" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${arc} ${c}`} />
          {p > 0 && (
            <circle cx={cx} cy={cx} r={r} fill="none" stroke="#0a84ff" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${arc * p} ${c}`} />
          )}
        </g>
        <circle cx={cx + r * Math.cos(a)} cy={cx + r * Math.sin(a)} r="3.2" fill="#0a84ff" stroke="#000" strokeWidth="1.5" />
      </svg>
      <div className="gauge-num">
        <b>{pct}</b>
        <small><IconDrop size={9} />%</small>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Komponen yang sering update (dipisah agar App tidak re-render)      */
/* ------------------------------------------------------------------ */
function useTrackPos(m: Media, at: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!m.playing) return;
    // Refresh tiap 100ms agar lirik karaoke sinkron tanpa delay terasa
    const id = window.setInterval(() => setTick((t) => t + 1), 100);
    return () => window.clearInterval(id);
  }, [m.playing]);
  return m.playing
    ? Math.min(m.duration || Infinity, m.position + (Date.now() - at) / 1000)
    : m.position;
}

function Progress({ media, at, onSeek }: { media: Media; at: number; onSeek: (s: number) => void }) {
  const pos = useTrackPos(media, at);
  const pct = media.duration ? Math.min(100, (pos / media.duration) * 100) : 0;
  return (
    <div className="progress-row">
      <span className="time-num">{fmtTime(pos)}</span>
      <div
        className="progress"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (media.duration > 0) onSeek(((e.clientX - r.left) / r.width) * media.duration);
        }}
      >
        <div style={{ width: `${pct}%` }}>
          <span className="thumb" />
        </div>
      </div>
      <span className="time-num">-{fmtTime(Math.max(0, media.duration - pos))}</span>
    </div>
  );
}

/* `offset` (detik) = antisipasi latensi audio 0,3 s + offset dari Pengaturan.
   Positif = baris aktif lebih awal. */
function LyricsView({ lyrics, media, at, offset, onSeek, t }: {
  lyrics: LyricsState; media: Media; at: number; offset: number; onSeek: (s: number) => void; t: T;
}) {
  const pos = useTrackPos(media, at);

  if (lyrics.loading) return <p className="hint">{t("lyricsSearching")}</p>;

  // Lirik tanpa timestamp: tampil sebagai teks biasa yang bisa di-scroll
  if ((!lyrics.lines || lyrics.lines.length === 0) && lyrics.plain && lyrics.plain.length > 0) {
    return (
      <div className="plain">
        {lyrics.plain.map((l, i) => <p key={i}>{l}</p>)}
      </div>
    );
  }
  if (!lyrics.lines || lyrics.lines.length === 0)
    return <p className="hint">{t("lyricsNone")}</p>;

  const lines = lyrics.lines;
  const leadPos = pos + offset;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= leadPos) idx = i;
    else break;
  }

  // Tampilkan 3 baris: sebelumnya, aktif (boleh 2 baris teks), berikutnya.
  // Cocok dengan tinggi notch lirik 140px.
  const from = Math.max(0, Math.min(idx - 1, lines.length - 3));
  const visible = lines.slice(from, from + 3);

  return (
    <div className="lines">
      {visible.map((l, i) => {
        const absIdx = from + i;
        const isActive = absIdx === idx;
        const isPast = absIdx < idx;
        return (
          <button
            key={`${l.t}-${absIdx}`}
            className={isActive ? "line on" : isPast ? "line past" : "line"}
            onClick={() => onSeek(l.t)}
          >
            {l.text}
          </button>
        );
      })}
    </div>
  );
}

/* Bar lirik satu baris (mode "bar"): tampil di notch saat lirik aktif,
   termasuk ketika ada aplikasi maximize / fullscreen. */
function LyricBar({ lyrics, media, at, trackKey, offset, onWidth, t }: {
  lyrics: LyricsState; media: Media; at: number; trackKey: string; offset: number;
  onWidth: (w: number) => void; t: T;
}) {
  const pos = useTrackPos(media, at);
  let text = "";
  if (lyrics.key !== trackKey || lyrics.loading) {
    text = t("lyricsSearching");
  } else if (lyrics.lines && lyrics.lines.length > 0) {
    const leadPos = pos + offset;
    let idx = -1;
    for (let i = 0; i < lyrics.lines.length; i++) {
      if (lyrics.lines[i].t <= leadPos) idx = i;
      else break;
    }
    text = idx >= 0 ? lyrics.lines[idx].text : "♪";
  } else if (lyrics.plain && lyrics.plain.length > 0) {
    text = t("lyricsUnsynced"); // satu baris tidak bisa mengikuti lagu tanpa timestamp
  } else {
    text = t("lyricsNone");
  }
  const w = barWidthFor(text);
  useEffect(() => {
    onWidth(w);
  }, [w, onWidth]);
  return (
    <div className="lyricbar">
      <span className="lb-icon"><IconNote /></span>
      <span key={text} className="lb-text">{text}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Komponen Utama                                                      */
/* ------------------------------------------------------------------ */
export default function App() {
  // --- konfigurasi bersama (dari jendela Pengaturan & menu tray) ---
  const [cfg, setCfg] = useState<Cfg>(loadCfg);
  const updateCfg = (fn: (c: Cfg) => Cfg) =>
    setCfg((prev) => {
      const n = fn(prev);
      saveCfg(n);
      return n;
    });
  const mascot = cfg.mascot;
  const t = useMemo(() => makeT(cfg.lang), [cfg.lang]);
  const lyricLead = 0.3 + cfg.lyricOffset / 1000; // 0,3 s = kompensasi buffer audio

  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === CFG_KEY) setCfg(loadCfg());
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  useEffect(() => {
    invoke("sync_tray", { mascot: cfg.mascot, minimal: cfg.minimal }).catch(() => {});
  }, [cfg.mascot, cfg.minimal]);
  // teks menu tray mengikuti bahasa UI
  useEffect(() => {
    invoke("set_tray_lang", { lang: cfg.lang }).catch(() => {});
  }, [cfg.lang]);
  // opsi ikon situs notifikasi diteruskan ke Rust (yang mengambil favicon)
  useEffect(() => {
    invoke("set_site_icons", { enabled: cfg.hud.siteIcons }).catch(() => {});
  }, [cfg.hud.siteIcons]);
  useTauriEvent<string>("tray_toggle", (k) =>
    updateCfg((c) => (k === "mascot" ? { ...c, mascot: !c.mascot } : { ...c, minimal: !c.minimal }))
  );

  // --- status dari Rust ---
  const [resting, setResting] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [power, setPower] = useState<Power>({ hasBattery: false, charging: false, percent: 0 });
  const [mediaState, setMediaState] = useState<{ m: Media; at: number }>({ m: EMPTY_MEDIA, at: Date.now() });
  const [clips, setClips] = useState<string[]>(() => (loadCfg().shelf.remember ? readClips() : []));
  const [shelf, setShelf] = useState<ShelfItem[]>(() => (loadCfg().shelf.emptyOnStart ? [] : readShelf()));

  useEffect(() => {
    if (cfg.shelf.remember) localStorage.setItem("migi.clips", JSON.stringify(clips));
    else localStorage.removeItem("migi.clips");
  }, [clips, cfg.shelf.remember]);

  // --- status tampilan ---
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const [hover, setHover] = useState(false);
  const [tabsOn, setTabsOn] = useState(false); // titik-titik di-hover -> tab bar ikon
  const [settle, setSettle] = useState(false); // sebentar setelah tab bar menutup: animasi mengecil tanpa pantulan
  const prevTabs = useRef(false);
  const settleTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (prevTabs.current && !tabsOn) {
      setSettle(true);
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => setSettle(false), 400);
    }
    prevTabs.current = tabsOn;
  }, [tabsOn]);
  const [openReady, setOpenReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [page, setPage] = useState<Page>("music");
  const [slideDir, setSlideDir] = useState<"left" | "right" | null>(null);
  const [lyricsOnRaw, setLyricsOn] = useState(false);
  const lyricsOn = lyricsOnRaw && cfg.lyrics;
  const [pill, setPill] = useState<Pill | null>(null);
  const [lyrics, setLyrics] = useState<LyricsState>({
    key: "", lines: null, plain: null, loading: false,
  });

  const [water, setWater] = useState<Water>(readWater);
  const [waterSettings, setWaterSettings] = useState(false);

  // --- Dashboard ---
  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  const [notifyAccess, setNotifyAccess] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [vol, setVol] = useState<VolInfo>({ level: 0, muted: false });
  const [bright, setBright] = useState<number | null>(null);
  const volTouched = useRef(0);
  const brightTimer = useRef<number | undefined>(undefined);
  const devBusy = useRef(false);
  const devAt = useRef(0);

  // --- Panel volume di player (klik ikon volume -> slider menggantikan tombol prev/play/next) ---
  const [volOpen, setVolOpen] = useState(false);
  const volCloseTimer = useRef<number | undefined>(undefined);
  const pokeVol = () => {
    window.clearTimeout(volCloseTimer.current);
    volCloseTimer.current = window.setTimeout(() => setVolOpen(false), VOL_PANEL_MS);
  };
  const toggleVolPanel = () => {
    if (volOpen) {
      window.clearTimeout(volCloseTimer.current);
      setVolOpen(false);
    } else {
      setVolOpen(true);
      pokeVol();
    }
  };

  const pillTimer = useRef<number | undefined>(undefined);
  const [osd, setOsd] = useState<Osd | null>(null);
  const osdTimer = useRef<number | undefined>(undefined);
  const brightTouched = useRef(0);
  const bootAt = useRef(Date.now()); // abaikan event awal saat app baru jalan
  const prevCharging = useRef<boolean | null>(null);
  const prevPct = useRef<number | null>(null);
  const lowSent = useRef(false); // popup "baterai lemah" sudah ditampilkan
  const fullSent = useRef(false); // popup "baterai penuh" sudah ditampilkan

  const media = mediaState.m;
  const trackKey = `${media.artist}|${media.title}`;

  // Warna gradasi bar lirik: diambil dari cover lagu (kiri & kanan gambar)
  const [barW, setBarW] = useState(360);
  const [artColors, setArtColors] = useState<[string, string]>(DEFAULT_ART);
  useEffect(() => {
    if (!media.art) {
      setArtColors(DEFAULT_ART);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        const N = 24;
        const cv = document.createElement("canvas");
        cv.width = N;
        cv.height = N;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, N, N);
        const data = ctx.getImageData(0, 0, N, N).data;
        const avg = (x0: number, x1: number): string => {
          let r = 0, g = 0, b = 0, w = 0;
          for (let y = 0; y < N; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * N + x) * 4;
              const R = data[i], G = data[i + 1], B = data[i + 2];
              const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
              if (mx < 40) continue; // abaikan area terlalu gelap
              const wt = 0.15 + (mx - mn) / 255; // utamakan warna yang hidup
              r += R * wt; g += G * wt; b += B * wt; w += wt;
            }
          }
          if (w === 0) return "60,60,70";
          r /= w; g /= w; b /= w;
          const k = 235 / Math.max(r, g, b, 1); // cerahkan supaya glow terlihat
          return `${Math.min(255, Math.round(r * k))},${Math.min(255, Math.round(g * k))},${Math.min(255, Math.round(b * k))}`;
        };
        setArtColors([avg(0, N / 2), avg(N / 2, N)]);
      } catch {
        setArtColors(DEFAULT_ART);
      }
    };
    img.onerror = () => setArtColors(DEFAULT_ART);
    img.src = media.art;
    return () => {
      cancelled = true;
    };
  }, [media.art]);

  const expanded = hover || dragging;

  // Bar lirik: aktif selama tombol lirik menyala dan ada lagu.
  // Mengalahkan mode mini, jadi tetap tampil walau ada app maximize/fullscreen.
  const barActive = lyricsOn && media.active;

  // "Mengecil" = ada app maximize (jika opsi aktif) ATAU notch minimal saat tidak ada musik
  const shrunk = (maximized && cfg.hideFullscreen) || (cfg.minimal && !media.playing);

  // Dari mode mini, buka bertahap: idle dulu, baru open.
  // Saat drag file atau bar lirik aktif, langsung buka tanpa jeda.
  const opened = expanded && (!shrunk || barActive || dragging || openReady);
  const waitingIdle = expanded && !opened;

  const mode: Mode = opened
    ? page === "music" && lyricsOn
      ? "lyrics"
      : tabsOn
      ? "tabs"
      : "open"
    : waitingIdle
    ? "idle"
    : osd
    ? "osd"
    : pill
    ? "pill"
    : barActive
    ? "bar"
    : shrunk
    ? "mini"
    : resting && mascot
    ? "rest"
    : "idle";

  // Timer jeda mini -> idle -> open
  useEffect(() => {
    if (!expanded) {
      setOpenReady(false); // reset saat kursor keluar
      return;
    }
    if (!shrunk || barActive) {
      setOpenReady(true); // bukan mode mini / bar lirik: tidak perlu jeda
      return;
    }
    const id = window.setTimeout(() => setOpenReady(true), MINI_TO_OPEN_MS);
    return () => window.clearTimeout(id);
  }, [expanded, shrunk, barActive]);

  const isExpanded = mode === "open" || mode === "tabs" || mode === "lyrics";

  // kursor keluar dari notch -> tab bar ditutup lagi
  useEffect(() => {
    if (!expanded) setTabsOn(false);
  }, [expanded]);

  // panel volume ditutup saat notch menutup atau pindah dari halaman musik
  useEffect(() => {
    if (!opened || page !== "music") {
      window.clearTimeout(volCloseTimer.current);
      setVolOpen(false);
    }
  }, [opened, page]);

  /* Pertahankan isi body selama animasi menutup, supaya fade-out mulus */
  const [bodyMode, setBodyMode] = useState<"open" | "lyrics" | null>(null);
  useEffect(() => {
    if (mode === "open" || mode === "tabs" || mode === "lyrics") {
      setBodyMode(mode === "lyrics" ? "lyrics" : "open");
      return;
    }
    const id = window.setTimeout(() => setBodyMode(null), ANIM_MS);
    return () => window.clearTimeout(id);
  }, [mode]);

  // saat terbuka langsung pakai mode (tanpa menunggu effect), saat menutup pakai bodyMode
  const shownBody: "open" | "lyrics" | null = isExpanded
    ? mode === "lyrics"
      ? "lyrics"
      : "open"
    : bodyMode;

  // simpan pill terakhir supaya isinya tetap ada saat fade-out
  const lastPill = useRef<Pill | null>(null);
  if (pill) lastPill.current = pill;
  const pillView = pill ?? lastPill.current;

  const showPill = (p: Pill) => {
    setPill(p);
    window.clearTimeout(pillTimer.current);
    pillTimer.current = window.setTimeout(() => setPill(null), PILL_MS);
  };

  // simpan OSD terakhir supaya isinya tetap ada saat fade-out
  const lastOsd = useRef<Osd | null>(null);
  if (osd) lastOsd.current = osd;
  const osdView = osd ?? lastOsd.current;

  const showOsd = (o: Osd) => {
    setOsd(o);
    window.clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => setOsd(null), OSD_MS);
  };

  // simpan Water; reset harian & pengingat (dicek tiap detik lewat `now`)
  useEffect(() => {
    localStorage.setItem("migi.water", JSON.stringify(water));
  }, [water]);
  // target & pengingat mengikuti jendela Pengaturan
  useEffect(() => {
    setWater((w) => ({ ...w, goal: cfg.water.goal, bell: cfg.water.on }));
  }, [cfg.water.goal, cfg.water.on]);
  useTauriEvent<null>("water_reset", () => setWater((w) => ({ ...w, ml: 0 })));
  useEffect(() => {
    if (dayKey(now) !== water.date) {
      setWater((w) => freshWater(w));
      return;
    }
    const mins = now.getHours() * 60 + now.getMinutes();
    const active = mins >= cfg.water.from && mins < cfg.water.until;
    if (water.bell && active && now.getTime() >= water.next) {
      const pct = Math.round((water.ml / water.goal) * 100);
      showPill({
        kind: "water",
        label: t("pageWater"),
        title: t("waterPillTitle"),
        sub: `${(water.ml / 1000).toFixed(1)} / ${(water.goal / 1000).toFixed(1)} L · ${pct}%`,
        right: t("agoNow"),
      });
      setWater((w) => ({ ...w, next: Date.now() + w.interval * 60000 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  const waterPct = Math.round((water.ml / water.goal) * 100);
  const drink = () => setWater((w) => ({ ...w, ml: w.ml + cfg.water.cup, next: Date.now() + w.interval * 60000 }));
  const toggleBell = () => {
    updateCfg((c) => ({ ...c, water: { ...c.water, on: !c.water.on } }));
    setWater((w) => ({ ...w, next: Date.now() + w.interval * 60000 }));
  };
  const stepGoal = (d: number) =>
    updateCfg((c) => ({ ...c, water: { ...c.water, goal: clamp(c.water.goal + d, 500, 5000) } }));
  const stepInterval = (d: number) =>
    setWater((w) => {
      const interval = clamp(w.interval + d, 15, 240);
      return { ...w, interval, next: Date.now() + interval * 60000 };
    });

  /* ---- event dari Rust ---- */
  useTauriEvent<boolean>("idle", setResting);
  useTauriEvent<boolean>("maximized", setMaximized);
  useTauriEvent<Media>("media", (p) =>
    setMediaState((prev) => {
      const sameTrack = prev.m.title === p.title && prev.m.artist === p.artist;
      const expected = prev.m.playing
        ? prev.m.position + (Date.now() - prev.at) / 1000
        : prev.m.position;
      // Sinkronisasi posisi lebih responsif (threshold 0.3s) agar lirik tidak drift atau delay
      if (
        sameTrack &&
        p.active === prev.m.active &&
        p.playing === prev.m.playing &&
        Math.abs(p.duration - prev.m.duration) < 1 &&
        Math.abs(p.position - expected) < 0.3
      ) return prev;
      return { m: { ...p, art: p.art ?? (sameTrack ? prev.m.art : null) }, at: Date.now() };
    })
  );

  /* Baterai: colok, cabut, lemah, penuh.
     "Lemah" & "penuh" hanya muncul sekali per kejadian (lowSent / fullSent). */
  useTauriEvent<Power>("power", (p) => {
    const prevC = prevCharging.current;
    const prevP = prevPct.current;
    const low = cfg.hud.lowBattery;

    if (cfg.hud.battery && p.hasBattery) {
      if (prevC === false && p.charging) {
        // charger dicolok
        if (p.percent >= 100) {
          fullSent.current = true;
          showPill({ kind: "battery", tone: "ok", title: t("fullTitle"), sub: t("fullSub"), right: "100%" });
        } else {
          showPill({ kind: "charging", title: t("chargingTitle"), sub: t("chargingSub"), right: `${p.percent}%` });
        }
      } else if (prevC === true && !p.charging) {
        // charger dicabut
        showPill({ kind: "battery", tone: "off", title: t("chargerOffTitle"), sub: t("chargerOffSub"), right: `${p.percent}%` });
      } else if (p.charging && p.percent >= 100 && !fullSent.current && prevP !== null) {
        // baterai penuh
        fullSent.current = true;
        showPill({ kind: "battery", tone: "ok", title: t("fullTitle"), sub: t("fullSub"), right: "100%" });
      } else if (!p.charging && p.percent <= low && !lowSent.current && prevP !== null) {
        // baterai lemah
        lowSent.current = true;
        showPill({ kind: "battery", tone: "warn", title: t("lowTitle"), sub: t("lowSub"), right: `${p.percent}%` });
      }
    }
    if (!p.charging) fullSent.current = false;
    if (p.charging || p.percent > low) lowSent.current = false;

    prevCharging.current = p.charging;
    prevPct.current = p.percent;
    setPower(p);
  });
  useTauriEvent<string>("clipboard", (text) => {
    if (!cfg.shelf.clipboard) return;
    setClips((prev) => [text, ...prev.filter((t) => t !== text)].slice(0, cfg.shelf.keep));
  });
  const refreshDevices = useCallback((force = false) => {
    if (devBusy.current) return;
    if (!force && Date.now() - devAt.current < 8000) return;
    devBusy.current = true;
    invoke<DeviceInfo[]>("get_devices")
      .then((d) => {
        setDevices(d);
        devAt.current = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        devBusy.current = false;
      });
  }, []);
  const refreshBrightness = useCallback(() => {
    invoke<number | null>("get_brightness").then(setBright).catch(() => {});
  }, []);

  useTauriEvent<{ name: string; connected: boolean; battery: number | null }>("bluetooth", (b) => {
    const name = b.name || t("btDevice");
    // perangkat terputus
    if (!b.connected) {
      if (cfg.hud.bluetooth) showPill({ kind: "bluetooth", tone: "off", title: name, sub: t("btDisconnected") });
      window.setTimeout(() => refreshDevices(true), 1000); // daftar di Dashboard ikut diperbarui
      return;
    }
    if (cfg.hud.bluetooth) showPill({ kind: "bluetooth", title: name, sub: t("btConnected") });
    // beri waktu Windows menyelesaikan koneksi, lalu ambil daftar + baterai terbaru
    // dan perbarui pill kalau baterainya berhasil dibaca
    window.setTimeout(() => {
      invoke<DeviceInfo[]>("get_devices")
        .then((d) => {
          setDevices(d);
          devAt.current = Date.now();
          const f = d.find((x) => x.name === b.name);
          if (cfg.hud.bluetooth && f && f.battery != null) {
            showPill({ kind: "bluetooth", title: name, sub: `${t("btConnected")} · ${f.battery}%` });
          }
        })
        .catch(() => {});
    }, 2500);
  });
  useTauriEvent<NotifItem>("notify", (n) => {
    setNotifs((prev) => [n, ...prev.filter((x) => x.id !== n.id)].slice(0, 20));
    if (cfg.hud.notify)
      showPill({
        kind: "notify",
        label: n.site || n.app,
        title: n.title || n.app,
        sub: n.body,
        right: t("agoNow"),
        icon: n.siteIcon ?? n.icon, // ikon situs (YouTube/Gmail) diutamakan, lalu logo aplikasi
        badge: n.siteIcon ? n.icon : null, // logo browser kecil di pojok ikon situs
      });
  });
  useTauriEvent<boolean>("notify_access", setNotifyAccess);
  useTauriEvent<VolInfo>("volume", (v) => {
    // abaikan sebentar setelah slider digeser supaya tidak "loncat balik"
    if (Date.now() - volTouched.current <= 700) return;
    const changed = v.level !== vol.level || v.muted !== vol.muted;
    setVol(v);
    // tombol volume keyboard -> OSD di notch (bukan saat notch sedang terbuka / baru start)
    if (cfg.hud.volume && changed && !opened && Date.now() - bootAt.current > 3000) {
      showOsd({ kind: "volume", value: v.level, muted: v.muted });
    }
  });
  useTauriEvent<number>("brightness", (v) => {
    if (Date.now() - brightTouched.current <= 1500) return; // dari slider Dashboard sendiri
    const changed = bright !== null && v !== bright;
    setBright(v);
    if (cfg.hud.brightness && changed && !opened && Date.now() - bootAt.current > 3000) {
      showOsd({ kind: "brightness", value: v });
    }
  });

  const changeVolume = (v: number) => {
    volTouched.current = Date.now();
    setVol({ level: v, muted: false });
    invoke("set_volume", { level: v }).catch(() => {});
  };
  const toggleMute = () => {
    volTouched.current = Date.now();
    const next = !vol.muted;
    setVol((s) => ({ ...s, muted: next }));
    invoke("set_mute", { muted: next }).catch(() => {});
  };
  const changeBrightness = (v: number) => {
    brightTouched.current = Date.now();
    setBright(v);
    window.clearTimeout(brightTimer.current);
    brightTimer.current = window.setTimeout(() => {
      invoke("set_brightness", { level: v }).catch(() => {});
    }, 150);
  };

  // data awal Dashboard
  useEffect(() => {
    invoke<NotifItem[]>("get_notifications")
      .then((list) =>
        setNotifs((prev) =>
          [...list, ...prev.filter((p) => !list.some((l) => l.id === p.id))]
            .sort((a, b) => b.at - a.at)
            .slice(0, 20)
        )
      )
      .catch(() => {});
    invoke<number>("get_notify_access")
      .then((v) => setNotifyAccess(v === 0 ? null : v === 1))
      .catch(() => {});
    invoke<VolInfo | null>("get_volume")
      .then((v) => v && setVol(v))
      .catch(() => {});
    refreshBrightness();
    refreshDevices(true);
  }, [refreshDevices, refreshBrightness]);

  // saat halaman Dashboard dibuka: segarkan semuanya
  useEffect(() => {
    if (page !== "dashboard" || !opened) return;
    refreshDevices();
    refreshBrightness();
    invoke<number>("get_notify_access")
      .then((v) => setNotifyAccess(v === 0 ? null : v === 1))
      .catch(() => {});
    invoke<VolInfo | null>("get_volume")
      .then((v) => v && setVol(v))
      .catch(() => {});
  }, [page, opened, refreshDevices, refreshBrightness]);

  /* ---- inisialisasi ---- */
  useEffect(() => {
    placeWindow(WINDOW_MAX);
    invoke<Power>("get_power")
      .then((p) => {
        prevCharging.current = p.charging;
        prevPct.current = p.percent;
        // kondisi yang sudah berlangsung saat Migi dibuka tidak memicu popup
        lowSent.current = p.hasBattery && !p.charging && p.percent <= cfg.hud.lowBattery;
        fullSent.current = p.charging && p.percent >= 100;
        setPower(p);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // zona hover untuk Rust: langsung mengikuti mode
  useEffect(() => {
    const r = mode === "bar" ? { w: barW, h: SIZES.bar.h } : hitRect(mode);
    invoke("set_hot", { w: r.w, h: r.h }).catch(() => {});
  }, [mode, barW]);

  // seret file ke notch -> buka Shelf
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragging(true);
          setPage("shelf");
        } else if (p.type === "drop") {
          const items = p.paths.map((path) => ({ path, name: path.split(/[\\/]/).pop() || path }));
          setShelf((prev) => {
            const merged = [...items, ...prev.filter((s) => !p.paths.includes(s.path))];
            localStorage.setItem("migi.shelf", JSON.stringify(merged));
            return merged;
          });
          setDragging(false);
        } else {
          setDragging(false);
        }
      })
      .then((f) => (cancelled ? f() : (un = f)))
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // lirik diambil saat tombol lirik aktif atau lagu berganti
  // (hasil bisa bersinkronisasi "synced" atau teks biasa)
  useEffect(() => {
    if (!lyricsOn || !media.active || lyrics.key === trackKey) return;
    const key = trackKey;
    setLyrics({ key, lines: null, plain: null, loading: true });
    invoke<{ synced: boolean; text: string } | null>("fetch_lyrics", {
      artist: media.artist,
      title: media.title,
      duration: Math.round(media.duration),
    })
      .then((r) => {
        if (!r) return setLyrics({ key, lines: null, plain: null, loading: false });
        if (r.synced) {
          const lines = parseLrc(r.text);
          setLyrics({ key, lines: lines.length ? lines : null, plain: null, loading: false });
        } else {
          setLyrics({ key, lines: null, plain: parsePlain(r.text), loading: false });
        }
      })
      .catch(() => setLyrics({ key, lines: null, plain: null, loading: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyricsOn, trackKey, media.active]);

  /* ---- aksi ---- */
  // hover dipantau Rust lewat posisi kursor (tahan 360 ms sebelum dianggap keluar)
  useTauriEvent<boolean>("hover", setHover);
  const slideTimer = useRef<number | undefined>(undefined);
  const go = useCallback((dir: 1 | -1) => {
    setSlideDir(dir === 1 ? "left" : "right");
    window.clearTimeout(slideTimer.current);
    slideTimer.current = window.setTimeout(() => setSlideDir(null), 320);
    setPage((prev) => {
      const i = PAGES.indexOf(prev);
      return PAGES[(i + dir + PAGES.length) % PAGES.length];
    });
  }, []);
  const seek = (sec: number) => {
    setMediaState((s) => ({ m: { ...s.m, position: sec }, at: Date.now() }));
    invoke("media_seek", { seconds: sec }).catch(() => {});
  };
  const removeShelf = (path: string) =>
    setShelf((prev) => {
      const next = prev.filter((s) => s.path !== path);
      localStorage.setItem("migi.shelf", JSON.stringify(next));
      return next;
    });
  const clearShelf = () => {
    localStorage.setItem("migi.shelf", "[]");
    setShelf([]);
  };

  /* ---- seret file KELUAR dari Shelf (tauri-plugin-drag) ----
     Klik biasa tetap membuka file; menggeser > 6px memulai drag ke aplikasi lain. */
  const dragFrom = useRef<{ x: number; y: number; path: string; started: boolean } | null>(null);
  const skipClick = useRef(false);
  const startShelfDrag = async (path: string) => {
    try {
      const icon = await invoke<string | null>("drag_icon");
      if (icon) await startDrag({ item: [path], icon });
    } catch (err) {
      console.error("startDrag:", err);
    }
  };
  const onCardDown = (e: ReactPointerEvent<HTMLDivElement>, path: string) => {
    if (e.button !== 0) return;
    skipClick.current = false;
    dragFrom.current = { x: e.clientX, y: e.clientY, path, started: false };
  };
  const onCardMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragFrom.current;
    if (!d || d.started || e.buttons !== 1) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    d.started = true;
    skipClick.current = true; // supaya klik setelah drag tidak ikut membuka file
    void startShelfDrag(d.path);
  };

  /* ---- bagian tampilan ---- */
  const showChrome = shownBody === "open";
  const size = mode === "bar" ? { w: barW, h: SIZES.bar.h } : SIZES[mode];

  /* Header: Kiri = Baterai Ring (petir saat charging), Tengah = Jam, Kanan = Equalizer Bars */
  const header = (
    <div className="header">
      <div className="left">
        <Ring percent={power.hasBattery ? power.percent : 100} charging={power.charging} size={18} />
      </div>
      <div className="center"><time className="time">{fmtClock(now)}</time></div>
      <div className="right">
        <Bars playing={media.playing} />
      </div>
    </div>
  );

  /* Bar atas: SELALU tampil di semua slide (kiri = judul slide, tengah = baterai + tanggal + jam, kanan = equalizer) */
  const [wTitle1, wTitle2] = t("pageWater").split(" ");
  const pageTitle: ReactNode =
    page === "dashboard"
      ? t("pageDashboard")
      : page === "water"
      ? (<>{wTitle1} <em>{wTitle2}</em></>)
      : page === "shelf"
      ? t("pageShelf")
      : page === "clipboard"
      ? t("pageClipboard")
      : null;
  const topbar = (
    <div className="topbar">
      <div className="topbar-title">{pageTitle}</div>
      <div className="topbar-center">
        <Ring percent={power.hasBattery ? power.percent : 100} charging={power.charging} size={17} />
        <span className="d">{fmtDate(now, cfg.lang)}</span>
        <span className="t">{fmtClock(now)}</span>
      </div>
      <div className="topbar-right"><Bars playing={media.playing} /></div>
    </div>
  );

  /* Navigasi bawah (semua halaman, posisinya selalu di tengah):
     - normal  : titik-titik halaman, notch tetap 140px
     - di-hover: titik-titik berubah jadi tab bar ikon, notch melebar jadi 160px (mode "tabs") */
  const nav = (
    <div
      className={tabsOn ? "navzone tabs" : "navzone"}
      onMouseEnter={() => setTabsOn(true)}
      onMouseLeave={() => setTabsOn(false)}
    >
      <div className="dots">
        {PAGES.map((p) => (
          <i key={p} className={p === page ? "on" : ""} />
        ))}
      </div>
      <div className="tabbar">
        <button className={page === "music" ? "on" : ""} onClick={() => setPage("music")} aria-label={t("pageMusic")}><IconNote /></button>
        <button className={page === "dashboard" ? "on" : ""} onClick={() => setPage("dashboard")} aria-label={t("pageDashboard")}><IconDash /></button>
        <button className={page === "water" ? "on" : ""} onClick={() => setPage("water")} aria-label={t("pageWater")}><IconDrop /></button>
        <button className={page === "shelf" ? "on" : ""} onClick={() => setPage("shelf")} aria-label={t("pageShelf")}><IconTray /></button>
        <button className={page === "clipboard" ? "on" : ""} onClick={() => setPage("clipboard")} aria-label={t("pageClipboard")}><IconClip /></button>
        <i className="sep" />
        <button onClick={() => invoke("show_settings")} aria-label={t("settings")}><IconGear /></button>
      </div>
    </div>
  );

  const player = (compact: boolean) => {
    if (compact) {
      return (
        <div className="player compact">
          <div className="player-top">
            <div className="art">{media.art ? <img src={media.art} alt="" /> : <span className="art-ph"><IconMusicNote /></span>}</div>
            <div className="track-info">
              <strong className="track-title">{media.title || t("notPlaying")}</strong>
              <small className="track-artist">{media.artist}</small>
            </div>
          </div>
          <Progress media={media} at={mediaState.at} onSeek={seek} />
          <div className="controls-compact">
            <button className={lyricsOn ? "tool-btn on" : "tool-btn"} onClick={() => setLyricsOn((v) => !v)} aria-label={t("lyrics")}><IconLyrics /></button>
            <button onClick={() => invoke("media_prev")} aria-label={t("prev")}><IconPrev /></button>
            <button onClick={() => invoke("media_toggle")} aria-label={media.playing ? t("pause") : t("play")}>
              {media.playing ? <IconPause /> : <IconPlay />}
            </button>
            <button onClick={() => invoke("media_next")} aria-label={t("next")}><IconNext /></button>
          </div>
        </div>
      );
    }

    return (
      <div className={media.active ? "player" : "player off"}>
        <div className="player-top">
          <div className="art">{media.art ? <img src={media.art} alt="" /> : <span className="art-ph"><IconMusicNote /></span>}</div>
          <div className="track-info">
            <strong className="track-title">{media.title || t("notPlaying")}</strong>
            <small className="track-artist">{media.artist}</small>
          </div>
        </div>

        <Progress media={media} at={mediaState.at} onSeek={seek} />

        <div className="player-bottom">
          <button
            className={lyricsOn ? "tool-btn on" : "tool-btn"}
            onClick={() => setLyricsOn((v) => !v)}
            aria-label={t("lyrics")}
            title={t("lyricsTitle")}
          >
            <IconLyrics />
          </button>

          {volOpen ? (
            <div className="vol-row">
              <button
                className="sbtn"
                onClick={() => {
                  toggleMute();
                  pokeVol();
                }}
                aria-label={t("mute")}
              >
                {vol.muted || vol.level === 0 ? <IconMute /> : <IconVolume />}
              </button>
              <Slider
                value={vol.muted ? 0 : vol.level}
                onChange={(v) => {
                  changeVolume(v);
                  pokeVol();
                }}
              />
              <span className="sval">{vol.muted ? 0 : vol.level}</span>
            </div>
          ) : (
            <div className="center-controls">
              <div className="playback-btns">
                <button onClick={() => invoke("media_prev")} aria-label={t("prev")}><IconPrev /></button>
                <button onClick={() => invoke("media_toggle")} aria-label={media.playing ? t("pause") : t("play")} className="play-btn">
                  {media.playing ? <IconPause /> : <IconPlay />}
                </button>
                <button onClick={() => invoke("media_next")} aria-label={t("next")}><IconNext /></button>
              </div>
            </div>
          )}

          <button
            className={volOpen ? "tool-btn vol on" : "tool-btn vol"}
            onClick={toggleVolPanel}
            aria-label={t("volume")}
            title={t("volume")}
          >
            <IconVolume />
          </button>
        </div>
      </div>
    );
  };

  /* Dashboard: padat, muat di area isi 352x92 (ukuran notch sama dengan halaman lain) */
  const dashboard = (
    <div className="dboard">
      <section className="dcol">
        <div className="dh">
          <span>{t("dashNotifs")}</span>
          {notifs.length > 0 && <button className="link" onClick={() => setNotifs([])}>{t("clear")}</button>}
        </div>
        <div className="nlist">
          {notifs.length === 0 ? (
            <div className="nempty">
              {notifyAccess === false ? (
                <>
                  <strong>{t("accessOff")}</strong>
                  <button className="link" onClick={() => invoke("open_notification_settings")}>{t("openSettings")}</button>
                </>
              ) : (
                <>
                  <strong>{t("noNotifs")}</strong>
                  <small>{t("noNotifsSub")}</small>
                </>
              )}
            </div>
          ) : (
            notifs.map((n) => (
              <div
                key={n.id}
                className="nitem"
                title={`${n.title} ${n.body}`.trim()}
                onClick={() => setNotifs((prev) => prev.filter((x) => x.id !== n.id))}
              >
                <div className="nmeta">
                  {(n.siteIcon ?? n.icon) && <img className="nicon" src={(n.siteIcon ?? n.icon) as string} alt="" />}
                  <span className="napp">{n.site || n.app}</span>
                  <span className="nago">{fmtAgo(n.at, now.getTime(), t)}</span>
                </div>
                <div className="ntext">
                  <b>{n.title}</b>
                  {n.body && <span>{n.body}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="dcol">
        <div className="dh"><span>{t("devices")}</span></div>
        <div className="dlist">
          <div className="drow">
            <span className="dicon"><IconLaptop /></span>
            <span className="dname">{t("thisPc")}</span>
            <Battery pct={power.hasBattery ? power.percent : null} charging={power.charging} />
          </div>
          {devices.map((d) => (
            <div key={d.name} className="drow">
              <span className="dicon"><DeviceIcon name={d.name} /></span>
              <span className="dname">{d.name}</span>
              <Battery pct={d.battery} />
            </div>
          ))}
        </div>
        <div className="sliders">
          <div className="srow">
            <button className="sbtn" onClick={toggleMute} aria-label={t("mute")}>
              {vol.muted || vol.level === 0 ? <IconMute /> : <IconVolume />}
            </button>
            <Slider value={vol.muted ? 0 : vol.level} onChange={changeVolume} />
            <span className="sval">{vol.muted ? 0 : vol.level}</span>
          </div>
          <div className="srow">
            <span className="sbtn"><IconSun /></span>
            <Slider value={bright ?? 0} onChange={changeBrightness} disabled={bright == null} accent="#ffd60a" />
            <span className="sval">{bright ?? "–"}</span>
          </div>
        </div>
      </section>
    </div>
  );

  let body: ReactNode = null;
  if (shownBody === "open") {
    if (page === "music") {
      body = player(false);
    } else if (page === "dashboard") {
      body = dashboard;
    } else if (page === "water") {
      body = (
        <div className="water">
          {waterSettings ? (
            <div className="water-main">
              <div className="w-row">
                <span>{t("waterGoal")}</span>
                <div className="stepper">
                  <button onClick={() => stepGoal(-250)} aria-label={t("goalDown")}>−</button>
                  <b>{(water.goal / 1000).toFixed(2).replace(/0$/, "")} L</b>
                  <button onClick={() => stepGoal(250)} aria-label={t("goalUp")}>+</button>
                </div>
              </div>
              <div className="w-row">
                <span>{t("waterInterval")}</span>
                <div className="stepper">
                  <button onClick={() => stepInterval(-15)} aria-label={t("intDown")}>−</button>
                  <b>{t("unitMin", { n: water.interval })}</b>
                  <button onClick={() => stepInterval(15)} aria-label={t("intUp")}>+</button>
                </div>
              </div>
              <div className="water-actions">
                <button className="w-btn primary" onClick={() => setWaterSettings(false)}>{t("done")}</button>
              </div>
            </div>
          ) : (
            <div className="water-main">
              <div className="water-top">
                <div className="water-amount">
                  <b>{(water.ml / 1000).toFixed(1)}</b>
                  <span>/ {(water.goal / 1000).toFixed(1)} L</span>
                </div>
                <button className={water.bell ? "bell on" : "bell"} onClick={toggleBell} aria-label={t("reminder")}><IconBell /></button>
              </div>
              <div className="water-bar"><i style={{ width: `${clamp(waterPct, 0, 100)}%` }} /></div>
              <div className="water-meta">
                {t("today")} · <em>{waterPct}%</em> · {t("waterNext")} {water.bell ? fmtClock(new Date(water.next)) : t("off")}
              </div>
              <div className="water-actions">
                <button className="w-btn primary" onClick={drink}><IconDrop size={13} />{t("drink")}</button>
                <button className="w-btn" onClick={() => setWaterSettings(true)}><IconSliders />{t("settings")}</button>
              </div>
            </div>
          )}
          <div className="water-gauge"><WaterGauge pct={waterPct} /></div>
        </div>
      );
    } else if (page === "shelf") {
      body = (
        <div className="shelf">
          {shelf.length === 0 ? (
            <div className={dragging ? "drop on" : "drop"}>
              <IconTrayBig />
              <strong>{t("shelfDrop")}</strong>
              <small>{t("shelfHint")}</small>
            </div>
          ) : (
            <div className="cards">
              {shelf.map((s) => (
                <div
                  key={s.path}
                  className="card"
                  title={s.path}
                  onPointerDown={(e) => onCardDown(e, s.path)}
                  onPointerMove={onCardMove}
                  onPointerUp={() => {
                    dragFrom.current = null;
                  }}
                  onClick={() => {
                    if (skipClick.current) {
                      skipClick.current = false;
                      return;
                    }
                    invoke("open_path", { path: s.path });
                  }}
                >
                  <span className="card-text">{s.name}</span>
                  <button
                    className="x"
                    aria-label={t("removeShelf")}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeShelf(s.path);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {shelf.length > 0 && (
            <div className="foot">
              <small>{t("fileCount", { n: shelf.length })}</small>
              <button className="link" onClick={clearShelf}>{t("clearAll")}</button>
            </div>
          )}
        </div>
      );
    } else {
      body = (
        <div className="shelf">
          {clips.length === 0 ? (
            <div className="drop"><strong>{t("clipEmpty")}</strong><small>{t("clipEmptySub")}</small></div>
          ) : (
            <div className="cards">
              {clips.map((c, i) => (
                <div key={`${i}-${c}`} className="card" onClick={() => invoke("clipboard_write", { text: c })}>
                  <span className="card-text">{c}</span>
                  <button
                    className="x"
                    aria-label={t("removeClip")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setClips((prev) => prev.filter((_, j) => j !== i));
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {clips.length > 0 && (
            <div className="foot">
              <span />
              <button className="link" onClick={() => setClips([])}>{t("clearAll")}</button>
            </div>
          )}
        </div>
      );
    }
  } else if (shownBody === "lyrics") {
    body = (
      <div className="lyrics-grid">
        {player(true)}
        <div className="lyrics">
          <LyricsView lyrics={lyrics} media={media} at={mediaState.at} offset={lyricLead} onSeek={seek} t={t} />
        </div>
      </div>
    );
  }

  return (
    <div className="notch-wrapper">
      <div
        className={`notch ${mode === "tabs" ? "open tabs" : mode}${settle ? " settle" : ""}`}
        style={{ width: size.w, height: size.h, "--art1": artColors[0], "--art2": artColors[1] } as CSSProperties}
      >
        {/* Lengkungan keluar di sudut kiri & kanan atas (Ears), disembunyikan lewat CSS di mode mini */}
        <Ear side="left" />
        <Ear side="right" />

        <div className="notch-content">
          <div className="layer eyes-layer">
            <div className="eyes" aria-label={t("restingLabel")}><i /><i /></div>
          </div>

          <div className="layer pill-layer">
            {pillView && (
              <div className="pill">
                <div className={`pill-icon ${pillView.kind}${pillView.tone ? " " + pillView.tone : ""}${pillView.icon ? " has-img" : ""}`}>
                  {pillView.icon ? (
                    <>
                      <img className="pi-main" src={pillView.icon} alt="" />
                      {pillView.badge && <img className="pi-badge" src={pillView.badge} alt="" />}
                    </>
                  ) : pillView.kind === "notify" ? (
                    <IconChat />
                  ) : pillView.kind === "bluetooth" ? (
                    <IconBt />
                  ) : pillView.kind === "water" ? (
                    <IconDrop size={20} />
                  ) : pillView.kind === "battery" ? (
                    <IconBattery />
                  ) : (
                    <IconBolt />
                  )}
                </div>
                <div className="pill-text">
                  {pillView.label && <small>{pillView.label}</small>}
                  <strong>{pillView.title}</strong>
                  <small>{pillView.sub}</small>
                </div>
                {pillView.kind === "bluetooth" ? (
                  <div className="pill-ring"><IconHeadphones /></div>
                ) : (
                  pillView.right && (
                    <span className={pillView.kind === "charging" || pillView.kind === "battery" ? "pill-big" : "pill-right"}>
                      {pillView.right}
                    </span>
                  )
                )}
              </div>
            )}
          </div>

          <div className="layer osd-layer">
            {osdView && (
              <div className="osd">
                <span className="osd-icon">
                  {osdView.kind === "brightness" ? <IconSun /> : osdView.muted || osdView.value === 0 ? <IconMute /> : <IconVolume />}
                </span>
                <div className="osd-track"><i style={{ width: `${osdView.muted ? 0 : osdView.value}%` }} /></div>
                <span className="osd-val">{osdView.muted ? 0 : osdView.value}</span>
              </div>
            )}
          </div>

          <div className="layer header-layer">{header}</div>

          {/* Bar lirik satu baris: tampil saat lirik aktif, walau ada app maximize */}
          <div className="layer bar-layer">
            <LyricBar lyrics={lyrics} media={media} at={mediaState.at} trackKey={trackKey} offset={lyricLead} onWidth={setBarW} t={t} />
          </div>

          {shownBody && (
            <>
              <div className={`body ${shownBody}${slideDir ? ` slide-${slideDir}` : ""}`}>
                {body}
                {showChrome && nav}
              </div>
              {showChrome && topbar}
              {showChrome && (
                <>
                  <button className="arrow left-arrow" onClick={() => go(-1)} aria-label={t("prevPage")}><IconChevron dir="left" /></button>
                  <button className="arrow right-arrow" onClick={() => go(1)} aria-label={t("nextPage")}><IconChevron dir="right" /></button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}