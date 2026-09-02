import { cn } from "@/lib/utils";

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-xl bg-surface-secondary", className)}
    />
  );
}

export function HomeSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-4 px-4 py-4", className)} aria-busy="true">
      <SkeletonBlock className="h-24 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock key={i} className="h-16 rounded-2xl" />
        ))}
      </div>
      <SkeletonBlock className="h-20 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("divide-y divide-border-default", className)} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <SkeletonBlock className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <SkeletonBlock className="h-3.5 w-1/3" />
            <SkeletonBlock className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
