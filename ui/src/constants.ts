"use client";

import type { BadgeVariant } from "@fanvue/ui";

export const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
  running: "success",
  starting: "warning",
  idle: "info",
  error: "error",
  restored: "info",
  killing: "warning",
  destroying: "error",
  paused: "warning",
  stalled: "error",
  disconnected: "default",
};

export const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  starting: "Starting",
  idle: "Idle",
  error: "Error",
  restored: "Restored",
  killing: "Killing",
  destroying: "Destroying",
  paused: "Paused",
  stalled: "Stalled",
  disconnected: "Disconnected",
};

export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  assigned: "Assigned",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

export const TASK_STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
  pending: "default",
  assigned: "info",
  running: "success",
  completed: "info",
  failed: "error",
  blocked: "warning",
  cancelled: "default",
};

export const PRIORITY_LABELS: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};

export const PRIORITY_COLOR: Record<number, string> = {
  0: "text-zinc-600",
  1: "text-red-400",
  2: "text-orange-400",
  3: "text-zinc-300",
  4: "text-zinc-500",
};

export function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
