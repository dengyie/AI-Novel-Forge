import { create } from "zustand";

export type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "ai-novel-theme";

function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyThemeClass(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.classList.toggle("dark", theme === "dark");
}

interface ThemeStoreState {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeStoreState>((set) => {
  const initialTheme = readInitialTheme();
  applyThemeClass(initialTheme);
  return {
    theme: initialTheme,
    setTheme: (theme) => {
      applyThemeClass(theme);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      } catch {
        // localStorage 不可用时静默降级为会话内主题
      }
      set({ theme });
    },
    toggleTheme: () =>
      set((state) => {
        const next: ThemeMode = state.theme === "dark" ? "light" : "dark";
        applyThemeClass(next);
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // 同上
        }
        return { theme: next };
      }),
  };
});
