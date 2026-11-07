import { detectLang, type Lang } from "./i18n";

export const CFG_KEY = "migi.cfg";

export type Cfg = {
  lang: Lang; // bahasa UI
  lyricOffset: number; // ms; positif = lirik muncul lebih awal
  mascot: boolean;
  minimal: boolean;
  hideFullscreen: boolean;
  lyrics: boolean;
  water: { on: boolean; goal: number; cup: number; from: number; until: number };
  shelf: { emptyOnStart: boolean; clipboard: boolean; keep: number; remember: boolean };
  hud: {
    volume: boolean;
    brightness: boolean;
    battery: boolean;
    bluetooth: boolean;
    notify: boolean;
    siteIcons: boolean; // ikon situs (YouTube, Gmail, dll) pada notifikasi browser
    lowBattery: number; // batas persen untuk popup "baterai lemah"
  };
};

export const DEFAULT_CFG: Cfg = {
  lang: detectLang(),
  lyricOffset: 0,
  mascot: true,
  minimal: false,
  hideFullscreen: true,
  lyrics: true,
  water: { on: true, goal: 1500, cup: 250, from: 8 * 60, until: 22 * 60 }, // menit sejak 00:00
  shelf: { emptyOnStart: false, clipboard: true, keep: 8, remember: false },
  hud: { volume: true, brightness: true, battery: true, bluetooth: true, notify: true, siteIcons: true, lowBattery: 20 },
};

export function loadCfg(): Cfg {
  try {
    const raw = JSON.parse(localStorage.getItem(CFG_KEY) ?? "{}");
    return {
      ...DEFAULT_CFG,
      mascot: localStorage.getItem("migi.mascot") !== "off", // kompatibel dengan versi lama
      ...raw,
      water: { ...DEFAULT_CFG.water, ...raw.water },
      shelf: { ...DEFAULT_CFG.shelf, ...raw.shelf },
      hud: { ...DEFAULT_CFG.hud, ...raw.hud },
    };
  } catch {
    return DEFAULT_CFG;
  }
}

export function saveCfg(c: Cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(c));
}