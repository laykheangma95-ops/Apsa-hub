import { cn } from "@/lib/utils";

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("animate-pulse rounded-xl bg-surface-secondary", className)} />
  );
}

/*
 * A skeleton is a promise about what is arriving. When its shape does not
 * match the screen that lands, the page visibly jumps and the wait feels
 * longer than it was — so each skeleton below mirrors the real layout block
 * for block, in the same order.
 */

/** Home: attention rows, range control, revenue, metric grid. */
export function HomeSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("stack-section screen-gutter pt-4", className)} aria-busy="true">
      <div className="space-y-2">
        <SkeletonBlock className="h-3 w-24" />
        <SkeletonBlock className="h-[62px] w-full rounded-2xl" />
        <SkeletonBlock className="h-[62px] w-full rounded-2xl" />
      </div>
      <div className="stack-group">
        <SkeletonBlock className="h-3 w-28" />
        <SkeletonBlock className="h-[46px] w-full rounded-full" />
        <SkeletonBlock className="h-[108px] w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBlock key={i} className="h-[104px] rounded-2xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Inbox and any avatar-led list. */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("divide-y divide-border-default", className)} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <SkeletonBlock className="size-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonBlock className="h-3.5 w-1/3" />
            <SkeletonBlock className="h-3 w-2/3" />
            <SkeletonBlock className="h-4 w-20 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Order, delivery and customer detail: status hero, then stacked sections. */
export function DetailSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("stack-section screen-gutter pt-4", className)} aria-busy="true">
      <SkeletonBlock className="h-[132px] w-full rounded-[26px]" />
      <div className="stack-group">
        <SkeletonBlock className="h-3 w-20" />
        <SkeletonBlock className="h-[120px] w-full rounded-2xl" />
      </div>
      <div className="stack-group">
        <SkeletonBlock className="h-3 w-24" />
        <SkeletonBlock className="h-[96px] w-full rounded-2xl" />
      </div>
    </div>
  );
}
