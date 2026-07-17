import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bell, BellOff, Circle, List, Moon, Sun, X } from "lucide-react";
import "./styles.css";

type LightState = "working" | "done" | "waiting" | "idle" | "quit";
type Theme = "dark" | "light";
type Style = "triple" | "single";

type Preferences = {
  muted: boolean;
  theme: Theme;
  style: Style;
  startWithWindows: boolean;
};

declare global {
  interface Window {
    codexTrafficLight: {
      onStateChange: (callback: (state: LightState) => void) => () => void;
      onPreferencesChange: (callback: (preferences: Preferences) => void) => () => void;
      getState: () => Promise<LightState>;
      setState: (state: LightState) => void;
      getPreferences: () => Promise<Preferences>;
      setPreferences: (preferences: Partial<Preferences>) => void;
      installHooks: () => Promise<string>;
      getPaths: () => Promise<Record<string, string>>;
      quit: () => void;
    };
  }
}

const orderedLights = ["waiting", "working", "done"] as const;

const labels: Record<LightState, string> = {
  working: "正在干活",
  done: "可以验收",
  waiting: "等你确认",
  idle: "空闲",
  quit: "退出",
};

const lightColor: Record<(typeof orderedLights)[number], string> = {
  waiting: "#EF5B5B",
  working: "#F5B942",
  done: "#34C76F",
};

const statusBadge: Record<LightState, string> = {
  working: "正在干活",
  done: "✓ 可以验收",
  waiting: "需要确认",
  idle: "空闲",
  quit: "退出",
};

function App() {
  const [state, setState] = useState<LightState>("idle");
  const [preferences, setPreferencesState] = useState<Preferences>({
    muted: false,
    theme: "dark",
    style: "triple",
    startWithWindows: false,
  });

  useEffect(() => {
    window.codexTrafficLight.getState().then(setState);
    window.codexTrafficLight.getPreferences().then(setPreferencesState);
    const removeState = window.codexTrafficLight.onStateChange(setState);
    const removePrefs = window.codexTrafficLight.onPreferencesChange((next) => {
      setPreferencesState(next);
    });
    return () => {
      removeState();
      removePrefs();
    };
  }, []);

  const activeLight = useMemo(() => {
    if (state === "waiting") return "waiting";
    if (state === "working") return "working";
    if (state === "done") return "done";
    return "idle";
  }, [state]);

  const dark = preferences.theme === "dark";
  const single = preferences.style === "single";
  const statusTone = state === "working" || state === "done" || state === "waiting" ? state : "idle";

  const updatePreferences = (patch: Partial<Preferences>) => {
    const next = { ...preferences, ...patch };
    setPreferencesState(next);
    window.codexTrafficLight.setPreferences(patch);
  };

  return (
    <main className={`shell ${dark ? "dark" : "light"} ${single ? "single" : "triple"}`}>
      <section className="body">
        <header className="status-header">
          <div className="status-title">Codex 状态</div>
          <div className={`status-badge ${statusTone}`}>{statusBadge[state]}</div>
        </header>
        <button
          className="close"
          title="退出"
          aria-label="退出"
          onClick={(event) => {
            event.stopPropagation();
            window.codexTrafficLight.quit();
          }}
        >
          <X size={14} strokeWidth={2.4} aria-hidden="true" />
        </button>

        <div className={single ? "single-light" : "lights"}>
          {(single ? [activeLight === "idle" ? "working" : activeLight] : orderedLights).map((light) => {
            const isActive = activeLight === light;
            const color = lightColor[light as keyof typeof lightColor];
            return (
              <div
                key={light}
                className={`lamp ${isActive ? "active" : ""} ${light}`}
                style={{ "--lamp-color": color } as React.CSSProperties}
                title={labels[light as LightState]}
                aria-label={labels[light as LightState]}
              >
                <span />
              </div>
            );
          })}
        </div>

        <div className="controls" onDoubleClick={(event) => event.stopPropagation()}>
          <button
            className="control-button"
            title="切换样式"
            aria-label="切换样式"
            onClick={() => updatePreferences({ style: single ? "triple" : "single" })}
          >
            {single ? <List size={17} strokeWidth={2.2} /> : <Circle size={15} strokeWidth={2.4} />}
          </button>
          <button
            className="control-button"
            title="明暗模式"
            aria-label="明暗模式"
            onClick={() => updatePreferences({ theme: dark ? "light" : "dark" })}
          >
            {dark ? <Sun size={17} strokeWidth={2.2} /> : <Moon size={16} strokeWidth={2.2} />}
          </button>
          <button
            className="control-button"
            title="声音提醒"
            aria-label="声音提醒"
            onClick={() => updatePreferences({ muted: !preferences.muted })}
          >
            {preferences.muted ? (
              <BellOff size={17} strokeWidth={2.2} />
            ) : (
              <Bell size={17} strokeWidth={2.2} />
            )}
          </button>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
