import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_STORAGE_KEY = "ai-novel-theme";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readInitialMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "system";
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") {
    return systemPrefersDark() ? "dark" : "light";
  }
  return mode;
}

function applyThemeClass(resolved: ResolvedTheme) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function persistMode(mode: ThemeMode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时静默降级为会话内主题
  }
}

interface ThemeStoreState {
  /** 用户选择的模式：白天 / 夜间 / 跟随系统 */
  theme: ThemeMode;
  /** 实际生效的主题（system 时由系统偏好解析） */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeStoreState>((set) => {
  const initialMode = readInitialMode();
  const initialResolved = resolveTheme(initialMode);
  applyThemeClass(initialResolved);

  // 跟随系统模式：监听系统主题变化，实时切换
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const onSystemThemeChange = () => {
      set((state) => {
        if (state.theme !== "system") {
          return state;
        }
        const resolvedTheme = resolveTheme("system");
        applyThemeClass(resolvedTheme);
        return { ...state, resolvedTheme };
      });
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onSystemThemeChange);
    } else if (typeof media.addListener === "function") {
      // 兼容旧 Safari
      media.addListener(onSystemThemeChange);
    }
  }

  return {
    theme: initialMode,
    resolvedTheme: initialResolved,
    setTheme: (theme) => {
      const resolvedTheme = resolveTheme(theme);
      applyThemeClass(resolvedTheme);
      persistMode(theme);
      set({ theme, resolvedTheme });
    },
    toggleTheme: () =>
      set((state) => {
        // 在 白天 → 夜间 → 跟随系统 之间循环
        const next: ThemeMode =
          state.theme === "light" ? "dark" : state.theme === "dark" ? "system" : "light";
        const resolvedTheme = resolveTheme(next);
        applyThemeClass(resolvedTheme);
        persistMode(next);
        return { theme: next, resolvedTheme };
      }),
  };
});
