import { useEffect, useRef } from "react";
import { createOperationGuard, type OperationGuard } from "@/lib/returns";

/**
 * An OperationGuard bound to this component's mounted lifetime: live from
 * mount, retired on unmount. Key the component by every identity dimension it
 * acts for (user, organization, record, grant) so any change unmounts it and
 * retires every operation it started.
 */
export function useOperationGuard(): OperationGuard {
  const ref = useRef<OperationGuard | null>(null);
  if (ref.current === null) ref.current = createOperationGuard();
  const guard = ref.current;

  useEffect(() => {
    guard.activate();
    return () => guard.retire();
  }, [guard]);

  return guard;
}
