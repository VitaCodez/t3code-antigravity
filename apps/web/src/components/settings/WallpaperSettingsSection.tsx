import type { CSSProperties } from "react";
import { useRef } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_WALLPAPER_BLUR,
  MAX_WALLPAPER_OPACITY,
  MIN_WALLPAPER_BLUR,
  MIN_WALLPAPER_OPACITY,
  type RetroFontPreset,
} from "@t3tools/contracts";
import { Upload, X } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  RETRO_FONT_DEFINITIONS,
  resolveWallpaperAccent,
  WALLPAPER_PRESET_DEFINITIONS,
} from "../../wallpaper";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

export function WallpaperSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    wallpaperMode,
    wallpaperPreset,
    wallpaperCustomUrl,
    wallpaperOpacity,
    wallpaperBlur,
    wallpaperPixelated,
    wallpaperAutoAccent,
    retroFontPreset,
  } = settings;

  const currentAccent = resolveWallpaperAccent(wallpaperMode, wallpaperPreset);

  const opacityRatio =
    (wallpaperOpacity - MIN_WALLPAPER_OPACITY) / (MAX_WALLPAPER_OPACITY - MIN_WALLPAPER_OPACITY);
  const opacitySliderStyle = {
    "--settings-slider-progress": `${opacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - opacityRatio}rem`,
  } as CSSProperties;

  const blurRatio =
    (wallpaperBlur - MIN_WALLPAPER_BLUR) / (MAX_WALLPAPER_BLUR - MIN_WALLPAPER_BLUR);
  const blurSliderStyle = {
    "--settings-slider-progress": `${blurRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - blurRatio}rem`,
  } as CSSProperties;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      alert("Image is too large. Please select an image under 10MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        updateSettings({
          wallpaperMode: "custom",
          wallpaperCustomUrl: result,
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <SettingsSection id="appearance-wallpaper" title="Wallpaper & Atmosphere">
      {/* Wallpaper Mode Selector */}
      <SettingsRow
        {...searchableSetting("wallpaper-mode")}
        description="Choose whether to display background wallpaper art behind your workspace."
        resetAction={
          wallpaperMode !== DEFAULT_UNIFIED_SETTINGS.wallpaperMode ? (
            <SettingResetButton
              label="wallpaper mode"
              onClick={() =>
                updateSettings({
                  wallpaperMode: DEFAULT_UNIFIED_SETTINGS.wallpaperMode,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={wallpaperMode === "none" ? "secondary" : "outline"}
              onClick={() => updateSettings({ wallpaperMode: "none" })}
            >
              Solid Theme
            </Button>
            <Button
              size="sm"
              variant={wallpaperMode === "preset" ? "secondary" : "outline"}
              onClick={() => updateSettings({ wallpaperMode: "preset" })}
            >
              Preset Wallpapers
            </Button>
            <Button
              size="sm"
              variant={wallpaperMode === "custom" ? "secondary" : "outline"}
              onClick={() => updateSettings({ wallpaperMode: "custom" })}
            >
              Custom Image
            </Button>
          </div>
        }
      />

      {/* Preset selection cards */}
      {wallpaperMode === "preset" ? (
        <div className="my-2 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {Object.values(WALLPAPER_PRESET_DEFINITIONS).map((def) => {
            const isSelected = wallpaperPreset === def.id;
            return (
              <button
                key={def.id}
                type="button"
                className={`group relative flex flex-col overflow-hidden rounded-xl border text-left transition-all ${
                  isSelected
                    ? "border-primary ring-2 ring-primary/40 shadow-lg"
                    : "border-border/60 hover:border-border hover:shadow-md"
                }`}
                onClick={() => updateSettings({ wallpaperPreset: def.id })}
              >
                <div className="relative h-28 w-full overflow-hidden bg-muted">
                  <img
                    alt={def.label}
                    src={def.url}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    style={{
                      imageRendering: def.pixelated ? "pixelated" : undefined,
                    }}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                  <div
                    className="absolute bottom-2 right-2 size-3.5 rounded-full border border-white/20 shadow-sm"
                    style={{ backgroundColor: def.accentColor }}
                    title={`Ambient accent: ${def.accentColor}`}
                  />
                </div>
                <div className="p-3 bg-card/60 backdrop-blur-xs flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm text-foreground">{def.label}</span>
                    {isSelected && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-primary px-1.5 py-0.5 rounded-sm bg-primary/10">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                    {def.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Custom image options */}
      {wallpaperMode === "custom" ? (
        <div className="my-2 space-y-3 rounded-lg border border-border/60 p-3.5 bg-card/40">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Input
                placeholder="Paste direct image URL (https://...)"
                value={
                  wallpaperCustomUrl.startsWith("data:")
                    ? "(Uploaded local image)"
                    : wallpaperCustomUrl
                }
                disabled={wallpaperCustomUrl.startsWith("data:")}
                onChange={(e) => updateSettings({ wallpaperCustomUrl: e.target.value })}
                className="text-xs font-mono pr-8"
              />
              {wallpaperCustomUrl && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => updateSettings({ wallpaperCustomUrl: "" })}
                  title="Clear custom wallpaper"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileUpload}
              />
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-3.5" />
                Upload Image
              </Button>
            </div>
          </div>
          {wallpaperCustomUrl ? (
            <div className="relative h-28 w-full overflow-hidden rounded-md border border-border/80">
              <img
                src={wallpaperCustomUrl}
                alt="Custom wallpaper preview"
                className="h-full w-full object-cover"
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Paste an online image URL or upload any PNG, JPG, WebP, or GIF from your device.
            </p>
          )}
        </div>
      ) : null}

      {/* Sliders: Opacity & Blur (shown when wallpaper is active) */}
      {wallpaperMode !== "none" ? (
        <>
          <SettingsRow
            {...searchableSetting("wallpaper-opacity")}
            description="Adjust wallpaper brightness and atmospheric contrast behind the code."
            resetAction={
              wallpaperOpacity !== DEFAULT_UNIFIED_SETTINGS.wallpaperOpacity ? (
                <SettingResetButton
                  label="wallpaper brightness"
                  onClick={() =>
                    updateSettings({
                      wallpaperOpacity: DEFAULT_UNIFIED_SETTINGS.wallpaperOpacity,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output
                  className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="wallpaper-opacity"
                >
                  {wallpaperOpacity}%
                </output>
                <input
                  aria-label="Wallpaper brightness"
                  className="settings-slider min-w-0 flex-1"
                  id="wallpaper-opacity"
                  max={MAX_WALLPAPER_OPACITY}
                  min={MIN_WALLPAPER_OPACITY}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (value >= MIN_WALLPAPER_OPACITY && value <= MAX_WALLPAPER_OPACITY) {
                      updateSettings({ wallpaperOpacity: value });
                    }
                  }}
                  step={5}
                  style={opacitySliderStyle}
                  type="range"
                  value={wallpaperOpacity}
                />
              </div>
            }
          />

          <SettingsRow
            {...searchableSetting("wallpaper-blur")}
            description="Blur the background to keep code and conversation text razor-sharp."
            resetAction={
              wallpaperBlur !== DEFAULT_UNIFIED_SETTINGS.wallpaperBlur ? (
                <SettingResetButton
                  label="wallpaper blur"
                  onClick={() =>
                    updateSettings({
                      wallpaperBlur: DEFAULT_UNIFIED_SETTINGS.wallpaperBlur,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center gap-3 sm:w-52">
                <output
                  className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="wallpaper-blur"
                >
                  {wallpaperBlur}px
                </output>
                <input
                  aria-label="Wallpaper blur"
                  className="settings-slider min-w-0 flex-1"
                  id="wallpaper-blur"
                  max={MAX_WALLPAPER_BLUR}
                  min={MIN_WALLPAPER_BLUR}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (value >= MIN_WALLPAPER_BLUR && value <= MAX_WALLPAPER_BLUR) {
                      updateSettings({ wallpaperBlur: value });
                    }
                  }}
                  step={1}
                  style={blurSliderStyle}
                  type="range"
                  value={wallpaperBlur}
                />
              </div>
            }
          />

          <SettingsRow
            {...searchableSetting("wallpaper-pixelated")}
            description="Maintain crisp pixel rendering without blur smoothing for 8-bit / pixel artwork."
            control={
              <Switch
                checked={wallpaperPixelated}
                onCheckedChange={(checked) => updateSettings({ wallpaperPixelated: checked })}
                aria-label="Pixel-art rendering"
              />
            }
          />
        </>
      ) : null}

      {/* Tip 1: Auto-Accent Color Matching (Ambient Tint) */}
      <SettingsRow
        {...searchableSetting("wallpaper-auto-accent")}
        description="Extract and synchronize UI accents, glowing borders, and focus rings to match the wallpaper."
        control={
          <div className="flex items-center gap-3">
            <div
              className="size-4 rounded-full border border-white/20 shadow-xs transition-colors"
              style={{ backgroundColor: currentAccent }}
              title={`Current accent: ${currentAccent}`}
            />
            <Switch
              checked={wallpaperAutoAccent}
              onCheckedChange={(checked) => updateSettings({ wallpaperAutoAccent: checked })}
              aria-label="Auto-accent tint matching"
            />
          </div>
        }
      />

      {/* Tip 2: Pixel-Art / Retro Monospace Font Support */}
      <SettingsRow
        {...searchableSetting("retro-font-preset")}
        description="Pair your environment with nostalgic arcade pixel art or vintage CRT terminal typography."
        resetAction={
          retroFontPreset !== DEFAULT_UNIFIED_SETTINGS.retroFontPreset ? (
            <SettingResetButton
              label="retro font"
              onClick={() =>
                updateSettings({
                  retroFontPreset: DEFAULT_UNIFIED_SETTINGS.retroFontPreset,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex flex-col gap-2 sm:w-64">
            <Select
              value={retroFontPreset}
              onValueChange={(val) => {
                if (val && val in RETRO_FONT_DEFINITIONS) {
                  updateSettings({ retroFontPreset: val as RetroFontPreset });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Retro font preset">
                <SelectValue>
                  {RETRO_FONT_DEFINITIONS[retroFontPreset]?.label ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {Object.entries(RETRO_FONT_DEFINITIONS).map(([key, def]) => (
                  <SelectItem key={key} value={key}>
                    <div className="flex flex-col">
                      <span className="font-medium">{def.label}</span>
                      <span className="text-[11px] text-muted-foreground">{def.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {retroFontPreset !== "none" ? (
              <div
                className="rounded border border-border/80 bg-muted/50 p-2 text-xs text-foreground select-none"
                style={{
                  fontFamily: RETRO_FONT_DEFINITIONS[retroFontPreset]?.family,
                }}
              >
                const status = &quot;READY_01&quot;;
              </div>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}
