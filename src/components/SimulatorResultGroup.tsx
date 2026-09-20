"use client";

import type { ReactNode } from "react";
import SimulatorResultGroupHeader, {
  type SimulatorGroupAvatar,
} from "@/components/SimulatorResultGroupHeader";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";

type SimulatorResultGroupProps = {
  groupKey: string;
  label: ReactNode;
  isOpen: boolean;
  avatarRows: SimulatorGroupAvatar[];
  remainingCount: number;
  onOpenChange: (open: boolean) => void;
  onCopyGroup?: () => void;
  copyLabel?: string;
  children: ReactNode;
};

/** Renders a collapsible named result group with optional type previews and copy action. */
export default function SimulatorResultGroup({
  groupKey,
  label,
  isOpen,
  avatarRows,
  remainingCount,
  onOpenChange,
  onCopyGroup,
  copyLabel,
  children,
}: SimulatorResultGroupProps) {
  return (
    <Collapsible
      className="group/simulation-group"
      data-result-group={groupKey}
      open={isOpen}
      onOpenChange={onOpenChange}
    >
      <SimulatorResultGroupHeader
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
