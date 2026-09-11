"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ResultRowProps = Omit<ComponentProps<typeof TypeIdentity>, "name" | "typeId" | "className"> & {
  name: string;
  typeId: number;
  children: ReactNode;
  showSwitch?: boolean;
  switchChecked?: boolean;
  onSwitchChange?: (checked: boolean) => void;
  switchTooltip?: string;
  switchPending?: boolean;
  switchDisabled?: boolean;
  showCheckbox?: boolean;
  checkboxChecked?: boolean;
  onCheckboxChange?: (checked: boolean) => void;
  checkboxTooltip?: string;
  checkboxPending?: boolean;
  checkboxDisabled?: boolean;
  disabled?: boolean;
  selected?: boolean;
  className?: string;
  identityClassName?: string;
  switchClassName?: string;
  checkboxClassName?: string;
};

/** Renders a consistent result row with optional leading switch and trailing checkbox controls. */
export default function ResultRow({
  name,
  typeId,
  children,
  showSwitch = false,
  switchChecked,
  onSwitchChange,
  switchTooltip = "Select row",
  switchPending = false,
  switchDisabled = false,
  showCheckbox = false,
  checkboxChecked,
  onCheckboxChange,
  checkboxTooltip = "Select row",
  checkboxPending = false,
  checkboxDisabled = false,
  disabled = false,
  selected = false,
  className,
  identityClassName,
  switchClassName,
  checkboxClassName,
  ...typeIdentityProps
}: ResultRowProps) {
  const controlTooltip = (
    control: ReactElement,
    tooltip: string,
    className?: string,
    showNarrowLabel = false,
  ) => (
    <span
      className={cn(
        "inline-flex items-center justify-center",
        showNarrowLabel && "relative",
        className,
      )}
    >
      {showNarrowLabel && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-full top-1/2 hidden -translate-y-1/2 mr-2 whitespace-nowrap font-mono text-[9px] font-normal uppercase text-muted-foreground max-[900px]:block"
        >
          {tooltip}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger render={control} />
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </span>
  );

  return (
    <div
      aria-disabled={disabled}
      data-disabled={disabled || undefined}
      data-selected={selected || undefined}
      className={cn(
        "group/result-row grid min-h-14 min-w-0 items-center gap-[13px] border-b border-border px-2 py-2.5 transition-colors hover:bg-muted/50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:hover:bg-accent data-[disabled=true]:pointer-events-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50",
        showSwitch && showCheckbox
          ? "grid-cols-[auto_minmax(0,1fr)_auto_auto]"
          : showSwitch
            ? "grid-cols-[auto_minmax(0,1fr)_auto]"
            : "grid-cols-[minmax(0,1fr)_auto]",
        "last:border-b-0",
        className,
      )}
    >
      {showSwitch
        && controlTooltip(
          switchPending ? (
            <Spinner aria-hidden="true" />
          ) : (
            <Switch
              aria-label={switchTooltip}
              checked={switchChecked}
              disabled={disabled || switchDisabled}
              onCheckedChange={onSwitchChange}
            />
          ),
          switchTooltip,
          cn("h-[18.4px] w-8", switchClassName),
        )}
      <TypeIdentity
        {...typeIdentityProps}
        name={name}
        typeId={typeId}
        className={cn("min-w-0", identityClassName)}
      />
      <div className="contents">{children}</div>
      {showCheckbox
        && controlTooltip(
          checkboxPending ? (
            <Spinner aria-hidden="true" />
          ) : (
            <Checkbox
              aria-label={checkboxTooltip}
              checked={checkboxChecked}
              disabled={disabled || checkboxDisabled}
              onCheckedChange={onCheckboxChange}
            />
          ),
          checkboxTooltip,
          cn("size-4", checkboxClassName),
          true,
        )}
    </div>
  );
}
