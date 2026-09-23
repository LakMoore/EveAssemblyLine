"use client";

import type { ReactNode } from "react";
import SimulationResultGroupHeader, {
  type SimulationGroupAvatar,
} from "@/components/SimulationResultGroupHeader";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";

type SimulationResultGroupProps = {
  groupKey: string;
  label: ReactNode;
  ariaLabel?: string;
  trailingContent?: ReactNode;
  variant?: "card" | "nested";
  allowOverflow?: boolean;
  isOpen: boolean;
  avatarRows: SimulationGroupAvatar[];
  remainingCount: number;
  switchChecked?: boolean;
  switchLabel?: string;
  switchDisabled?: boolean;
  onSwitchChange?: (checked: boolean) => void;
  onOpenChange: (open: boolean) => void;
  onCopyGroup?: () => void;
  copyLabel?: string;
  children: ReactNode;
};

/** Renders a collapsible named result group with optional type previews and copy action. */
export default function SimulationResultGroup({
  groupKey,
  label,
  ariaLabel,
  trailingContent,
  variant = "card",
  allowOverflow = false,
  isOpen,
  avatarRows,
  remainingCount,
  switchChecked,
  switchLabel,
  switchDisabled,
  onSwitchChange,
  onOpenChange,
  onCopyGroup,
  copyLabel,
  children,
}: SimulationResultGroupProps) {
  const group = (
    <Collapsible
      className={
        variant === "nested"
          ? "group/simulation-group border-t border-border"
          : "group/simulation-group"
      }
      data-result-group={groupKey}
      open={isOpen}
      onOpenChange={onOpenChange}
    >
      <SimulationResultGroupHeader
        label={label}
        ariaLabel={ariaLabel}
        trailingContent={trailingContent}
        isOpen={isOpen}
        avatarRows={avatarRows}
        remainingCount={remainingCount}
        switchChecked={switchChecked}
        switchLabel={switchLabel}
        switchDisabled={switchDisabled}
        onSwitchChange={onSwitchChange}
        onCopyGroup={onCopyGroup}
        copyLabel={copyLabel}
      />
      <CollapsibleContent className="px-2">{children}</CollapsibleContent>
    </Collapsible>
  );

  return variant === "nested" ? (
    group
  ) : (
    <Card className={`${allowOverflow ? "overflow-visible " : ""}pt-0`}>{group}</Card>
  );
}
