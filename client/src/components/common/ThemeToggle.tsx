import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useThemeStore, type ThemeMode } from "@/store/themeStore";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  className?: string;
}

const MODE_META: Record<ThemeMode, { label: string; icon: typeof Sun }> = {
  light: { label: "白天模式", icon: Sun },
  dark: { label: "夜间模式", icon: Moon },
  system: { label: "跟随系统", icon: Monitor },
};

export default function ThemeToggle({ className }: ThemeToggleProps) {
  const theme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const { label, icon: Icon } = MODE_META[theme];

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn("h-8 w-8", className)}
      onClick={toggleTheme}
      aria-label={`当前：${label}，点击切换`}
      title={`当前：${label}（点击在 白天 / 夜间 / 跟随系统 间切换）`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
