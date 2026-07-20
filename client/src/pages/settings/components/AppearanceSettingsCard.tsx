import { Monitor, Moon, Sun } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useThemeStore, type ThemeMode } from "@/store/themeStore";

const THEME_OPTIONS: Array<{
  value: ThemeMode;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: "light",
    label: "白天",
    description: "亮色界面，适合光线充足的环境。",
    icon: Sun,
  },
  {
    value: "dark",
    label: "夜间",
    description: "暗色界面，适合弱光环境下长时间写作。",
    icon: Moon,
  },
  {
    value: "system",
    label: "跟随系统",
    description: "根据系统的白天/夜间外观自动切换。",
    icon: Monitor,
  },
];

export default function AppearanceSettingsCard() {
  const theme = useThemeStore((state) => state.theme);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const setTheme = useThemeStore((state) => state.setTheme);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">界面外观</CardTitle>
        <CardDescription>
          在白天、夜间或跟随系统之间切换，选择会自动保存并在下次打开时生效。
          {theme === "system" ? ` 当前系统为${resolvedTheme === "dark" ? "夜间" : "白天"}，已应用对应主题。` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3 sm:max-w-lg">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setTheme(option.value)}
                className={cn(
                  "flex flex-col items-start gap-1.5 rounded-xl border bg-background p-3 text-left transition hover:border-primary/40 hover:bg-primary/5",
                  active && "border-primary/50 bg-primary/10",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon className="h-4 w-4" />
                  {option.label}
                </span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
