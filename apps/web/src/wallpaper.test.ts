import { describe, expect, it } from "vitest";
import {
  RETRO_FONT_DEFINITIONS,
  resolveWallpaperAccent,
  resolveWallpaperUrl,
  WALLPAPER_PRESET_DEFINITIONS,
} from "./wallpaper";

describe("wallpaper", () => {
  describe("WALLPAPER_PRESET_DEFINITIONS", () => {
    it("includes cyberpunk-kowloon matching Capy AI style", () => {
      const kowloon = WALLPAPER_PRESET_DEFINITIONS["cyberpunk-kowloon"];
      expect(kowloon).toBeDefined();
      expect(kowloon.label).toBe("Cyberpunk Kowloon");
      expect(kowloon.url).toBe("/wallpapers/cyberpunk-kowloon.png");
      expect(kowloon.accentColor).toBe("#00e5ff");
      expect(kowloon.pixelated).toBe(true);
    });

    it("includes all bundled presets with non-empty accent colors", () => {
      const presets = Object.values(WALLPAPER_PRESET_DEFINITIONS);
      expect(presets.length).toBe(5);
      for (const preset of presets) {
        expect(preset.label.length).toBeGreaterThan(0);
        expect(preset.url.length).toBeGreaterThan(0);
        expect(preset.accentColor).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });
  });

  describe("resolveWallpaperUrl", () => {
    it("returns null when wallpaperMode is none", () => {
      expect(resolveWallpaperUrl("none", "cyberpunk-kowloon", "https://custom.png")).toBeNull();
    });

    it("returns preset url when wallpaperMode is preset", () => {
      expect(resolveWallpaperUrl("preset", "cyberpunk-kowloon", "")).toBe(
        "/wallpapers/cyberpunk-kowloon.png",
      );
    });

    it("returns trimmed custom url when wallpaperMode is custom", () => {
      expect(
        resolveWallpaperUrl("custom", "cyberpunk-kowloon", "  https://example.com/art.png  "),
      ).toBe("https://example.com/art.png");
    });

    it("returns null when custom url is empty", () => {
      expect(resolveWallpaperUrl("custom", "cyberpunk-kowloon", "   ")).toBeNull();
    });
  });

  describe("resolveWallpaperAccent", () => {
    it("resolves preset signature accent color", () => {
      expect(resolveWallpaperAccent("preset", "cyberpunk-kowloon")).toBe("#00e5ff");
      expect(resolveWallpaperAccent("preset", "synthwave-sunset")).toBe("#ff71ce");
      expect(resolveWallpaperAccent("preset", "lofi-rain")).toBe("#f59e0b");
      expect(resolveWallpaperAccent("preset", "matrix-code")).toBe("#10b981");
      expect(resolveWallpaperAccent("preset", "deep-space")).toBe("#a855f7");
    });

    it("uses custom accent when provided for custom mode", () => {
      expect(resolveWallpaperAccent("custom", "cyberpunk-kowloon", "#3b82f6")).toBe("#3b82f6");
    });
  });

  describe("RETRO_FONT_DEFINITIONS", () => {
    it("includes all retro font presets with valid font families", () => {
      expect(RETRO_FONT_DEFINITIONS["none"].family).toBe("");
      expect(RETRO_FONT_DEFINITIONS["vt323"].family).toContain("VT323");
      expect(RETRO_FONT_DEFINITIONS["press-start"].family).toContain("Press Start 2P");
      expect(RETRO_FONT_DEFINITIONS["silkscreen"].family).toContain("Silkscreen");
      expect(RETRO_FONT_DEFINITIONS["retro-code"].family).toContain("Fixedsys");
    });
  });
});
