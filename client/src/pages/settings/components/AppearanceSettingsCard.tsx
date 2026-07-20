import { Moon, Sun } from "lucide-react";
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
];

export default function AppearanceSettingsCard() {
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">界面外观</CardTitle>
        <CardDescription>在白天与夜间主题之间切换，选择会自动保存并在下次打开时生效。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
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
