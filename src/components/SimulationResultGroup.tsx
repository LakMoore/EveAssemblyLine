"use client";

import type { ReactNode } from "react";
import SimulationResultGroupHeader, {
  type SimulationGroupAvatar,
} from "@/components/SimulationResultGroupHeader";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";

type SimulationResultGroupProps = {
  groupKey: string;
  label: ReactNode;
  isOpen: boolean;
  avatarRows: SimulationGroupAvatar[];
  remainingCount: number;
  onOpenChange: (open: boolean) => void;
  onCopyGroup?: () => void;
  copyLabel?: string;
  children: ReactNode;
};

/** Renders a collapsible named result group with optional type previews and copy action. */
export default function SimulationResultGroup({
  groupKey,
  label,
  isOpen,
  avatarRows,
  remainingCount,
  onOpenChange,
  onCopyGroup,
  copyLabel,
  children,
}: SimulationResultGroupProps) {
  return (
    <Collapsible
      className="group/simulation-group"
      data-result-group={groupKey}
      open={isOpen}
      onOpenChange={onOpenChange}
    >
      <SimulationResultGroupHeader
        label={label}
        isOpen={isOpen}
        avatarRows={avatarRows}
        remainingCount={remainingCount}
        onCopyGroup={onCopyGroup}
        copyLabel={copyLabel}
      />
      <CollapsibleContent className="border-l-2 border-border pl-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}
