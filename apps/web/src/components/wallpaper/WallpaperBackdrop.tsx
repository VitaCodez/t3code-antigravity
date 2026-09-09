import { useState } from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveWallpaperUrl, WALLPAPER_PRESET_DEFINITIONS } from "../../wallpaper";

export function WallpaperBackdrop() {
  const settings = usePrimarySettings();
  const [loadError, setLoadError] = useState(false);

  const {
    wallpaperMode,
    wallpaperPreset,
    wallpaperCustomUrl,
    wallpaperOpacity,
    wallpaperBlur,
    wallpaperPixelated,
  } = settings;

  if (wallpaperMode === "none") {
    return null;
  }

  const wallpaperUrl = resolveWallpaperUrl(wallpaperMode, wallpaperPreset, wallpaperCustomUrl);
  if (!wallpaperUrl || loadError) {
    return null;
  }

  const presetDef = WALLPAPER_PRESET_DEFINITIONS[wallpaperPreset];
  const isPixelated = wallpaperPixelated || (wallpaperMode === "preset" && presetDef?.pixelated);
  const dimmingFactor = Math.max(0, Math.min(100, 100 - wallpaperOpacity)) / 100;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
      data-wallpaper-backdrop=""
    >
      {/* Background artwork */}
      <img
        alt=""
        className="h-full w-full object-cover transition-opacity duration-300"
        onError={() => setLoadError(true)}
        onLoad={() => setLoadError(false)}
        src={wallpaperUrl}
        style={{
          filter: wallpaperBlur > 0 ? `blur(${wallpaperBlur}px)` : undefined,
          imageRendering: isPixelated ? "pixelated" : undefined,
          transform: wallpaperBlur > 0 ? "scale(1.05)" : undefined,
        }}
      />

      {/* Base legibility scrim layer across the whole background */}
      <div
        className="absolute inset-0 bg-black/40"
        style={{ opacity: 0.45 + dimmingFactor * 0.45 }}
      />

      {/* Ambient dark vignette & vertical contrast gradient */}
      <div
        className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/55 to-black/35"
        style={{ opacity: 0.55 + dimmingFactor * 0.4 }}
      />

      {/* Center readability focus scrim so reading area maintains contrast against bright neon signs */}
      <div
        className="absolute inset-0 bg-radial-[circle_at_center] from-black/35 via-black/50 to-black/80"
        style={{ opacity: 0.5 + dimmingFactor * 0.5 }}
      />
    </div>
  );
}
