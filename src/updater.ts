import { useCallback, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdState =
  | { s: "idle" }
  | { s: "checking" }
  | { s: "none" }
  | { s: "available"; version: string }
  | { s: "downloading"; pct: number }
  | { s: "error" };

let pending: Update | null = null;

export function useUpdater() {
  const [st, setSt] = useState<UpdState>({ s: "idle" });

  const find = useCallback(async () => {
    setSt({ s: "checking" });
    try {
      const u = await check();
      if (!u) {
        setSt({ s: "none" });
        return;
      }
      pending = u;
      setSt({ s: "available", version: u.version });
    } catch (err) {
      console.error("updater check:", err);
      setSt({ s: "error" });
    }
  }, []);

  const install = useCallback(async () => {
    if (!pending) return;
    let total = 0;
    let got = 0;
    setSt({ s: "downloading", pct: 0 });
    try {
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
        } else if (e.event === "Progress") {
          got += e.data.chunkLength;
          setSt({ s: "downloading", pct: total ? Math.round((got / total) * 100) : 0 });
        }
      });
      // Di Windows, aplikasi biasanya sudah menutup sendiri saat installer berjalan.
      await relaunch();
    } catch (err) {
      console.error("updater install:", err);
      setSt({ s: "error" });
    }
  }, []);

  return { st, find, install };
}