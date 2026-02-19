"use client";

/** Reusable skeleton/shimmer components for loading states. */

interface SkeletonProps {
  className?: string;
}

/** Base skeleton block with pulse animation. */
export function Skeleton({ className = "" }: SkeletonProps) {
  return <div className={`animate-pulse rounded bg-zinc-800/50 ${className}`} />;
}

/** Skeleton that mimics an AgentCard on the Dashboard. */
export function AgentCardSkeleton() {
  return (
    <div className="h-28 rounded-lg bg-zinc-800/30 border border-zinc-800/50 p-4 flex flex-col justify-between">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-28" />
      </div>
    </div>
  );
}

/** Skeleton for the AgentView header bar. */
export function AgentHeaderSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-5 w-16 rounded-full" />
    </div>
  );
}

/** Skeleton for a settings file tree list. */
export function TreeListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list with fixed order
        <div key={i} className="flex items-center gap-2 px-2">
          <Skeleton className="h-3 w-3 rounded-sm" />
          <Skeleton className={`h-3 ${i % 3 === 0 ? "w-32" : i % 3 === 1 ? "w-24" : "w-28"}`} />
        </div>
      ))}
    </div>
  );
}

/** Skeleton for a Sidebar agent list item. */
export function SidebarItemSkeleton() {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Skeleton className="h-2 w-2 rounded-full" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}
