import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AntigravityQuotaSummary } from "@t3tools/contracts";

import { AntigravityQuotaSection, CircularQuotaGauge } from "./AntigravityQuotaSection.tsx";

const mockQuota: AntigravityQuotaSummary = {
  fetchedAt: "2026-09-01T12:00:00Z",
  groups: [
    {
      name: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        {
          id: "gemini-weekly",
          name: "Weekly Limit Remaining",
          window: "weekly",
          remainingFraction: 0.94,
          resetTime: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        },
        {
          id: "gemini-5h",
          name: "Five Hour Limit Remaining",
          window: "5h",
          remainingFraction: 0.82,
          resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
        },
      ],
    },
    {
      name: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        {
          id: "3p-weekly",
          name: "Weekly Limit Remaining",
          window: "weekly",
          remainingFraction: 1.0,
          resetTime: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        },
      ],
    },
  ],
};

describe("AntigravityQuotaSection", () => {
  it("renders empty string when quota is missing or empty", () => {
    expect(renderToStaticMarkup(<AntigravityQuotaSection quota={null} />)).toBe("");
    expect(
      renderToStaticMarkup(<AntigravityQuotaSection quota={{ fetchedAt: "", groups: [] }} />),
    ).toBe("");
  });

  it("renders quota groups and circular gauge percentages", () => {
    const html = renderToStaticMarkup(<AntigravityQuotaSection quota={mockQuota} />);

    expect(html).toContain("Antigravity Quotas &amp; Limits");
    expect(html).toContain("Gemini Models");
    expect(html).toContain("Claude and GPT models");
    expect(html).toContain("94%");
    expect(html).toContain("82%");
    expect(html).toContain("100%");
  });

  it("renders single circular gauge correctly", () => {
    const html = renderToStaticMarkup(
      <CircularQuotaGauge
        bucket={{
          id: "test",
          name: "Test Bucket",
          window: "5h",
          remainingFraction: 0.75,
          resetTime: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        }}
      />,
    );

    expect(html).toContain("75%");
    expect(html).toContain("Test Bucket");
  });
});
