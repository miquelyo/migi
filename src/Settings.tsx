import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { CFG_KEY, loadCfg, saveCfg, type Cfg } from "./config";
import { LANGS, makeT, type T } from "./i18n";
import { useUpdater } from "./updater";

type Sec = "general" | "music" | "water" | "shelf" | "hud" | "about";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const };
const SECTIONS: { id: Sec; key: "secGeneral" | "secMusic" | "secWater" | "secShelf" | "secHud" | "secAbout"; color: string; icon: ReactNode }[] = [
  {
    id: "general", key: "secGeneral", color: "#8e8e93",
    icon: <><path d="M3 8h10M19 8h2M3 16h2M11 16h10" {...stroke} /><circle cx="16" cy="8" r="2.6" {...stroke} /><circle cx="8" cy="16" r="2.6" {...stroke} /></>,
  },
  { id: "music", key: "secMusic", color: "#ff375f", icon: <path d="M9 3v11.3A3.5 3.5 0 1010 17V8h6V3z" fill="currentColor" /> },
  { id: "water", key: "secWater", color: "#0a84ff", icon: <path d="M12 2.5c3.5 4.4 6 7.5 6 10.6a6 6 0 01-12 0c0-3.1 2.5-6.2 6-10.6z" fill="currentColor" /> },
  { id: "shelf", key: "secShelf", color: "#ff9f0a", icon: <path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 2h6l1-2h5" {...stroke} strokeLinejoin="round" /> },
  { id: "hud", key: "secHud", color: "#32ade6", icon: <path d="M12 3a6 6 0 00-6 6v4l-2 3h16l-2-3V9a6 6 0 00-6-6zm-2 15a2 2 0 004 0z" fill="currentColor" /> },
  { id: "about", key: "secAbout", color: "#636366", icon: <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1 5h2v2h-2zm0 4h2v6h-2z" fill="currentColor" /> },
];

const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const fmtOffset = (ms: number) => `${ms > 0 ? "+" : ""}${(ms / 1000).toFixed(1)} s`;

/* ---------- komponen kecil ---------- */
const Toggle = ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => (
  <button role="switch" aria-checked={on} className={on ? "st-tg on" : "st-tg"} onClick={() => onChange(!on)}>
    <i />
  </button>
);

const Row = ({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) => (
  <div className="st-row">
    <div className="st-rt">
      <b>{title}</b>
      {sub && <small>{sub}</small>}
    </div>
    {children}
  </div>
);

const Card = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <h3 className="st-h">{title}</h3>
    <div className="st-card">{children}</div>
  </section>
);

function Seg<V extends string | number>({ value, options, onChange }: {
  value: V; options: { v: V; l: string }[]; onChange: (v: V) => void;
}) {
  const found = options.findIndex((o) => o.v === value);
  const i = Math.max(0, found);
  return (
    <div className={found < 0 ? "st-seg none" : "st-seg"} style={{ "--n": options.length, "--i": i } as CSSProperties}>
      <span className="st-ind" />
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>{o.l}</button>
      ))}
    </div>
  );
}

const Step = ({ label, onMinus, onPlus, t }: { label: string; onMinus: () => void; onPlus: () => void; t: T }) => (
  <div className="st-step">
    <button onClick={onMinus} aria-label={t("decrease")}>−</button>
    <b>{label}</b>
    <button onClick={onPlus} aria-label={t("increase")}>+</button>
  </div>
);

/* ---------- halaman utama ---------- */
export default function Settings() {
  const [sec, setSec] = useState<Sec>("general");
  const [cfg, setCfg] = useState<Cfg>(loadCfg);
  const [autostart, setAutostart] = useState(false);
  const [ver, setVer] = useState("");
  const { st, find, install } = useUpdater();
  const t = makeT(cfg.lang);

  const update = (fn: (c: Cfg) => Cfg) =>
    setCfg((prev) => {
      const next = fn(prev);
      saveCfg(next);
      return next;
    });

  useEffect(() => {
    invoke<boolean>("get_autostart").then(setAutostart).catch(() => {});
    getVersion().then(setVer).catch(() => {});
    // perubahan dari tray / jendela notch ikut tersinkron
    const on = (e: StorageEvent) => {
      if (e.key === CFG_KEY) setCfg(loadCfg());
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  const toggleAutostart = (v: boolean) =>
    invoke<boolean>("set_autostart", { enabled: v }).then(setAutostart).catch(() => {});

  /* ---- teks status pembaruan ---- */
  const updText =
    st.s === "checking" ? t("updChecking")
    : st.s === "none" ? t("updNone")
    : st.s === "available" ? t("updAvailable", { v: st.version })
    : st.s === "downloading" ? t("updDownloading", { n: st.pct })
    : st.s === "error" ? t("updError")
    : undefined;

  /* ---- tombol uji ---- */
  const testNotify = () => emit("notify", { id: Date.now(), app: "Messages", title: "Migi", body: t("testNotifBody"), at: Date.now() });
  const testBluetooth = () => emit("bluetooth", { name: "AirBuds Pro", connected: true, battery: 70 });
  const testBluetoothOff = () => emit("bluetooth", { name: "AirBuds Pro", connected: false, battery: null });
  const power = (charging: boolean, percent: number) => emit("power", { hasBattery: true, charging, percent });
  const seq = async (steps: [boolean, number][]) => {
    for (const [c, p] of steps) {
      await power(c, p);
      await new Promise((r) => window.setTimeout(r, 300));
    }
  };
  const testCharging = () => seq([[false, 70], [true, 70]]);
  const testUnplug = () => seq([[true, 70], [false, 70]]);
  const testLow = () => seq([[false, cfg.hud.lowBattery + 1], [false, cfg.hud.lowBattery]]);
  const testFull = () => seq([[true, 99], [true, 100]]);

  const w = cfg.water;
  const setHud = (k: keyof Cfg["hud"], v: boolean) => update((c) => ({ ...c, hud: { ...c.hud, [k]: v } }));

  const page = (() => {
    switch (sec) {
      case "general":
        return (
          <>
            <Card title={t("cardStartup")}>
              <Row title={t("autostart")}><Toggle on={autostart} onChange={toggleAutostart} /></Row>
            </Card>
            <Card title={t("cardLanguage")}>
              <Row title={t("language")}>
                <Seg value={cfg.lang} options={LANGS} onChange={(v) => update((c) => ({ ...c, lang: v }))} />
              </Row>
            </Card>
            <Card title={t("cardNotch")}>
              <Row title={t("minimal")} sub={t("minimalSub")}>
                <Toggle on={cfg.minimal} onChange={(v) => update((c) => ({ ...c, minimal: v }))} />
              </Row>
              <Row title={t("mascot")} sub={t("mascotSub")}>
                <Toggle on={cfg.mascot} onChange={(v) => update((c) => ({ ...c, mascot: v }))} />
              </Row>
            </Card>
            <Card title={t("cardFullscreen")}>
              <Row title={t("hideFs")} sub={t("hideFsSub")}>
                <Toggle on={cfg.hideFullscreen} onChange={(v) => update((c) => ({ ...c, hideFullscreen: v }))} />
              </Row>
            </Card>
          </>
        );
      case "music":
        return (
          <Card title={t("cardLyrics")}>
            <Row title={t("showLyrics")} sub={t("showLyricsSub")}>
              <Toggle on={cfg.lyrics} onChange={(v) => update((c) => ({ ...c, lyrics: v }))} />
            </Row>
            <Row title={t("lyricOffset")} sub={t("lyricOffsetSub")}>
              <Step
                t={t}
                label={fmtOffset(cfg.lyricOffset)}
                onMinus={() => update((c) => ({ ...c, lyricOffset: clamp(c.lyricOffset - 100, -5000, 5000) }))}
                onPlus={() => update((c) => ({ ...c, lyricOffset: clamp(c.lyricOffset + 100, -5000, 5000) }))}
              />
            </Row>
          </Card>
        );
      case "water":
        return (
          <>
            <Card title={t("cardReminder")}>
              <Row title={t("drinkReminder")} sub={t("drinkReminderSub")}>
                <Toggle on={w.on} onChange={(v) => update((c) => ({ ...c, water: { ...c.water, on: v } }))} />
              </Row>
            </Card>
            <Card title={t("cardPlan")}>
              <Row title={t("dailyGoal")}>
                <Seg
                  value={w.goal}
                  options={[{ v: 1000, l: "1 L" }, { v: 1500, l: "1.5 L" }, { v: 2000, l: "2 L" }, { v: 2500, l: "2.5 L" }, { v: 3000, l: "3 L" }]}
                  onChange={(v) => update((c) => ({ ...c, water: { ...c.water, goal: v } }))}
                />
              </Row>
              <Row title={t("cupSize")}>
                <Step
                  t={t}
                  label={`${w.cup} ml`}
                  onMinus={() => update((c) => ({ ...c, water: { ...c.water, cup: clamp(c.water.cup - 50, 100, 1000) } }))}
                  onPlus={() => update((c) => ({ ...c, water: { ...c.water, cup: clamp(c.water.cup + 50, 100, 1000) } }))}
                />
              </Row>
              <Row title={t("activeFrom")}>
                <Step
                  t={t}
                  label={fmtMin(w.from)}
                  onMinus={() => update((c) => ({ ...c, water: { ...c.water, from: clamp(c.water.from - 30, 0, c.water.until - 30) } }))}
                  onPlus={() => update((c) => ({ ...c, water: { ...c.water, from: clamp(c.water.from + 30, 0, c.water.until - 30) } }))}
                />
              </Row>
              <Row title={t("activeUntil")}>
                <Step
                  t={t}
                  label={fmtMin(w.until)}
                  onMinus={() => update((c) => ({ ...c, water: { ...c.water, until: clamp(c.water.until - 30, c.water.from + 30, 1410) } }))}
                  onPlus={() => update((c) => ({ ...c, water: { ...c.water, until: clamp(c.water.until + 30, c.water.from + 30, 1410) } }))}
                />
              </Row>
            </Card>
            <Card title={t("today")}>
              <Row title={t("todayProgress")}>
                <button className="st-link danger" onClick={() => emit("water_reset", null)}>{t("reset")}</button>
              </Row>
            </Card>
          </>
        );
      case "shelf":
        return (
          <>
            <Card title={t("cardShelf")}>
              <Row title={t("emptyOnStart")} sub={t("emptyOnStartSub")}>
                <Toggle on={cfg.shelf.emptyOnStart} onChange={(v) => update((c) => ({ ...c, shelf: { ...c.shelf, emptyOnStart: v } }))} />
              </Row>
            </Card>
            <Card title={t("cardClipboard")}>
              <Row title={t("cardClipboard")} sub={t("clipHistorySub")}>
                <Toggle on={cfg.shelf.clipboard} onChange={(v) => update((c) => ({ ...c, shelf: { ...c.shelf, clipboard: v } }))} />
              </Row>
              <Row title={t("keepUpTo")}>
                <Step
                  t={t}
                  label={t("items", { n: cfg.shelf.keep })}
                  onMinus={() => update((c) => ({ ...c, shelf: { ...c.shelf, keep: clamp(c.shelf.keep - 1, 1, 50) } }))}
                  onPlus={() => update((c) => ({ ...c, shelf: { ...c.shelf, keep: clamp(c.shelf.keep + 1, 1, 50) } }))}
                />
              </Row>
              <Row title={t("remember")} sub={t("rememberSub")}>
                <Toggle on={cfg.shelf.remember} onChange={(v) => update((c) => ({ ...c, shelf: { ...c.shelf, remember: v } }))} />
              </Row>
            </Card>
          </>
        );
      case "hud":
        return (
          <>
            <Card title={t("cardIndicators")}>
              <Row title={t("volume")}><Toggle on={cfg.hud.volume} onChange={(v) => setHud("volume", v)} /></Row>
              <Row title={t("brightness")}><Toggle on={cfg.hud.brightness} onChange={(v) => setHud("brightness", v)} /></Row>
            </Card>
            <Card title={t("cardPopups")}>
              <Row title={t("charger")}><Toggle on={cfg.hud.battery} onChange={(v) => setHud("battery", v)} /></Row>
              <Row title={t("lowLevel")}>
                <Step
                  t={t}
                  label={`${cfg.hud.lowBattery}%`}
                  onMinus={() => update((c) => ({ ...c, hud: { ...c.hud, lowBattery: clamp(c.hud.lowBattery - 5, 5, 50) } }))}
                  onPlus={() => update((c) => ({ ...c, hud: { ...c.hud, lowBattery: clamp(c.hud.lowBattery + 5, 5, 50) } }))}
                />
              </Row>
              <Row title={t("bluetooth")}><Toggle on={cfg.hud.bluetooth} onChange={(v) => setHud("bluetooth", v)} /></Row>
              <Row title={t("dashNotifs")}><Toggle on={cfg.hud.notify} onChange={(v) => setHud("notify", v)} /></Row>
              <Row title={t("siteIcons")} sub={t("siteIconsSub")}>
                <Toggle on={cfg.hud.siteIcons} onChange={(v) => setHud("siteIcons", v)} />
              </Row>
            </Card>
            <Card title={t("cardTest")}>
              <div className="st-tests">
                <button onClick={testNotify}>{t("testNotif")}</button>
                <button onClick={testBluetooth}>{t("testBt")}</button>
                <button onClick={testBluetoothOff}>{t("testBtOff")}</button>
                <button onClick={testCharging}>{t("testCharger")}</button>
                <button onClick={testUnplug}>{t("testUnplug")}</button>
                <button onClick={testLow}>{t("testLow")}</button>
                <button onClick={testFull}>{t("testFull")}</button>
              </div>
            </Card>
          </>
        );
      case "about":
        return (
          <>
            <div className="st-about">
              <img className="st-logo-img" src="/migi-logo.png" alt="Migi" />
              <h2>Migi</h2>
              <p>{t("version", { v: ver })}</p>
              <p>{t("tagline")}</p>
            </div>
            <Card title={t("cardUpdate")}>
              <Row title={t("cardUpdate")} sub={updText}>
                {st.s === "available" ? (
                  <button className="st-link" onClick={install}>{t("updInstall")}</button>
                ) : (
                  <button
                    className="st-link"
                    onClick={find}
                    disabled={st.s === "checking" || st.s === "downloading"}
                  >
                    {t("updCheck")}
                  </button>
                )}
              </Row>
            </Card>
            <Card title={t("cardInfo")}>
              <Row title={t("cardLyrics")}>
                <button className="st-link" onClick={() => invoke("open_link", { url: "https://lrclib.net" })}>LRCLIB ›</button>
              </Row>
              <Row title={t("madeBy")}><span className="st-val">Miguel</span></Row>
            </Card>
          </>
        );
    }
  })();

  return (
    <div className="st">
      <aside className="st-side">
        <div className="st-drag" data-tauri-drag-region>
          <button className="st-close" aria-label={t("close")} onClick={() => invoke("close_settings")} />
        </div>
        <nav className="st-nav">
          {SECTIONS.filter((s) => s.id !== "about").map((s) => (
            <button key={s.id} className={s.id === sec ? "st-item on" : "st-item"} onClick={() => setSec(s.id)}>
              <span className="st-ic" style={{ background: s.color }}>
                <svg viewBox="0 0 24 24" width="15" height="15">{s.icon}</svg>
              </span>
              {t(s.key)}
            </button>
          ))}
        </nav>
        <button className={sec === "about" ? "st-item on" : "st-item"} onClick={() => setSec("about")}>
          <span className="st-ic" style={{ background: "#636366" }}>
            <svg viewBox="0 0 24 24" width="15" height="15">{SECTIONS[5].icon}</svg>
          </span>
          {t("secAbout")}
        </button>
      </aside>

      <main className="st-main">
        <div className="st-top" data-tauri-drag-region />
        <div className="st-page" key={sec}>
          <h1>{t(SECTIONS.find((s) => s.id === sec)!.key)}</h1>
          {page}
        </div>
      </main>
    </div>
  );
}