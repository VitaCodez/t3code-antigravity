import type { AntigravityQuotaBucket, AntigravityQuotaSummary } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { AntigravityIcon } from "../Icons";

interface AntigravityQuotaSectionProps {
  readonly quota: AntigravityQuotaSummary | null | undefined;
  readonly className?: string;
}

function formatResetCountdown(resetTimeIso: string): string {
  const resetMs = new Date(resetTimeIso).getTime();
  const diffMs = resetMs - Date.now();
  if (isNaN(resetMs) || diffMs <= 0) return "Refreshes soon";

  const diffMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMinutes / 60);
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const remainingMins = diffMinutes % 60;

  if (days > 0) {
    return `Refreshes in ${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    return `Refreshes in ${hours}h ${remainingMins}m`;
  }
  return `Refreshes in ${remainingMins}m`;
}

function getQuotaColor(fraction: number): { stroke: string; text: string } {
  if (fraction >= 0.5) {
    return {
      stroke: "#10b981",
      text: "text-emerald-500 dark:text-emerald-400",
    };
  }
  if (fraction >= 0.2) {
    return {
      stroke: "#f59e0b",
      text: "text-amber-500 dark:text-amber-400",
    };
  }
  return {
    stroke: "#ef4444",
    text: "text-rose-500 dark:text-rose-400",
  };
}

interface CircularQuotaGaugeProps {
  readonly bucket: AntigravityQuotaBucket;
}

export function CircularQuotaGauge({ bucket }: CircularQuotaGaugeProps) {
  const fraction = Math.max(0, Math.min(1, bucket.remainingFraction));
  const percentage = Math.round(fraction * 100);
  const colors = getQuotaColor(fraction);

  // SVG Circular Geometry
  const size = 52;
  const strokeWidth = 4.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - fraction);

  const countdown = bucket.resetTime ? formatResetCountdown(bucket.resetTime) : null;

  return (
    <div className="flex min-w-0 items-center gap-3.5 rounded-lg border border-border/50 bg-background/50 p-2.5 transition-colors hover:border-border/80">
      <div
        className="relative flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} className="-rotate-90">
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-muted/20 dark:text-muted/30"
          />
          {/* Progress circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke={colors.stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{
              transition: "stroke-dashoffset 0.8s ease-in-out, stroke 0.4s ease",
            }}
          />
        </svg>
        {/* Percentage Label */}
        <span className={cn("absolute text-xs font-semibold tabular-nums", colors.text)}>
          {percentage}%
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate text-xs font-medium text-foreground">{bucket.name}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {countdown ?? (bucket.window === "5h" ? "5-hour window" : "Weekly window")}
        </span>
      </div>
    </div>
  );
}

export function AntigravityQuotaSection({ quota, className }: AntigravityQuotaSectionProps) {
  // Trigger periodic re-render to update the "Refreshes in Xm" countdown smoothly
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!quota || quota.groups.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-4 backdrop-blur-xs",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AntigravityIcon className="size-4 text-[#4285F4]" />
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            Antigravity Quotas & Limits
          </h3>
        </div>
        <span className="text-[11px] text-muted-foreground font-mono">Rolling Limits</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {quota.groups.map((group) => (
          <div
            key={group.name}
            className="flex flex-col gap-2.5 rounded-lg border border-border/40 bg-card/60 p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">{group.name}</span>
              {group.description ? (
                <span
                  className="truncate text-[10px] text-muted-foreground max-w-[200px]"
                  title={group.description}
                >
                  {group.description.replace(/^Models within this group:\s*/i, "")}
                </span>
              ) : null}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {group.buckets.map((bucket) => (
                <CircularQuotaGauge key={bucket.id} bucket={bucket} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
