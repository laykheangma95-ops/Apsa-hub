import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { BottomSheet, ListSkeleton } from "@/design-system";
import { OperationalState } from "@/components/common/OperationalState";
import { getWorkspaces, switchWorkspace } from "@/lib/api";
import { localName } from "@/lib/format";
import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { WorkspaceSummary } from "@/types";

interface WorkspaceSwitcherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitched?: (workspace: WorkspaceSummary) => void;
}

export function WorkspaceSwitcherSheet({
  open,
  onOpenChange,
  onSwitched,
}: WorkspaceSwitcherSheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [switching, setSwitching] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const query = useQuery({ queryKey: ["workspaces"], queryFn: getWorkspaces, enabled: open });
  const items = query.data ?? [];
  const current = items.find((w) => (activeId ? w.id === activeId : w.active));
  const single = items.length <= 1;

  async function choose(workspace: WorkspaceSummary) {
    if (current?.id === workspace.id) {
      onOpenChange(false);
      return;
    }
    setSwitching(workspace.id);
    const next = await switchWorkspace(workspace.id);
    setSwitching(null);
    setActiveId(next.id);
    onSwitched?.(next);
    onOpenChange(false);
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("team.workspace.title")}
      snap="half"
      className="lg:max-w-[480px]"
    >
      {query.isLoading ? <ListSkeleton rows={2} /> : null}

      {query.isError ? (
        <OperationalState
          title={t("team.workspace.errorTitle")}
          body={t("team.workspace.errorBody")}
          tone="danger"
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {!query.isLoading && !query.isError ? (
        <div className="space-y-3">
          {single ? (
            <p className="text-caption text-text-secondary">{t("team.workspace.singleHint")}</p>
          ) : null}

          <ul className="space-y-2">
            {items.map((workspace) => {
              const isCurrent = current?.id === workspace.id;
              return (
                <li key={workspace.id}>
                  <button
                    type="button"
                    onClick={() => void choose(workspace)}
                    aria-current={isCurrent ? "true" : undefined}
                    disabled={switching !== null}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                      isCurrent
                        ? "border-action-primary bg-action-primary-soft"
                        : "border-border-default bg-surface-primary",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-label block break-words text-text-primary">
                        {localName(workspace, language)}
                      </span>
                      <span className="text-caption block break-words text-text-secondary">
                        {t(`team.workspace.type.${workspace.type}`)} · {workspace.city} ·{" "}
                        {t(`team.role.${workspace.role}`)}
                      </span>
                    </span>
                    {switching === workspace.id ? (
                      <span className="text-caption shrink-0 text-text-secondary">
                        {t("team.workspace.switching")}
                      </span>
                    ) : isCurrent ? (
                      <span className="flex shrink-0 items-center gap-1 text-action-primary">
                        <Check className="size-5" aria-hidden />
                        <span className="text-caption">{t("team.workspace.current")}</span>
                      </span>
                    ) : (
                      <span className="text-caption shrink-0 text-action-primary">
                        {t("team.workspace.switch")}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <Button variant="outline" className="tap-target h-12 w-full" disabled>
            {t("team.workspace.settingsSoon")}
          </Button>
        </div>
      ) : null}
    </BottomSheet>
  );
}
