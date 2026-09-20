"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type SwitchedResultRowProps = Omit<
  ComponentProps<typeof TypeIdentity>,
  "name" | "typeId" | "className"
> & {
  name: string;
  typeId: number;
  children: ReactNode;
  switchChecked?: boolean;
  onSwitchChange?: (checked: boolean) => void;
  switchTooltip?: string;
  switchPending?: boolean;
  switchDisabled?: boolean;
  showSwitch?: boolean;
  checkboxChecked?: boolean;
  onCheckboxChange?: (checked: boolean) => void;
  checkboxTooltip?: string;
  checkboxPending?: boolean;
  checkboxDisabled?: boolean;
  showCheckbox?: boolean;
  installed?: boolean;
  disabled?: boolean;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
  identityClassName?: string;
  contentClassName?: string;
  switchClassName?: string;
  checkboxClassName?: string;
};

/** Renders a selectable result with a leading inclusion switch and trailing completion checkbox. */
export default function SwitchedResultRow({
  name,
  typeId,
  children,
  switchChecked,
  onSwitchChange,
  switchTooltip = "Include result",
  switchPending = false,
  switchDisabled = false,
  showSwitch = true,
  checkboxChecked,
  onCheckboxChange,
  checkboxTooltip = "Complete result",
  checkboxPending = false,
  checkboxDisabled = false,
  showCheckbox = true,
  installed = false,
  disabled = false,
  selected = false,
  onClick,
  className,
  identityClassName,
  contentClassName,
  switchClassName,
  checkboxClassName,
  ...typeIdentityProps
}: SwitchedResultRowProps) {
  return (
    <div
      aria-disabled={disabled}
      data-disabled={disabled || undefined}
      data-installed={installed || undefined}
      data-selected={selected || undefined}
      role={onClick ? "group" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Select ${name}` : undefined}
      className={cn(
        "group/result-row grid min-h-14 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-[13px] gap-y-2 border-b border-border px-2 py-2.5 transition-colors hover:bg-muted/50 data-[disabled=true]:pointer-events-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[installed=true]:hover:bg-transparent data-[installed=true]:**:data-result-row-content:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:hover:bg-accent sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto] sm:items-center",
        className,
      )}
      onClick={onClick}
      onKeyDown={(event) => {
        if (
          onClick
          && event.currentTarget === event.target
          && (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {showSwitch && (
        <ResultRowControl className={cn("col-start-1 row-start-1 sm:row-auto", switchClassName)}>
          {switchPending ? (
            <Spinner aria-hidden="true" />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Switch
                    aria-label={switchTooltip}
                    checked={switchChecked}
                    disabled={disabled || installed || switchDisabled}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={onSwitchChange}
                  />
                }
              />
              <TooltipContent>{switchTooltip}</TooltipContent>
            </Tooltip>
          )}
        </ResultRowControl>
      )}
      <TypeIdentity
        {...typeIdentityProps}
        name={name}
        typeId={typeId}
        className={cn(
          "col-start-2 row-start-1 min-w-0 sm:row-auto",
          !showSwitch && "col-start-1",
          identityClassName,
        )}
      />
      <div
        className={cn(
          "col-span-2 col-start-2 row-start-2 flex min-w-0 items-center justify-end gap-1 sm:col-span-1 sm:col-start-3 sm:row-auto",
          !showSwitch && "col-start-1",
          contentClassName,
        )}
      >
        {children}
      </div>
      {showCheckbox && (
        <ResultRowControl
          className={cn("col-start-3 row-start-1 sm:col-start-4 sm:row-auto", checkboxClassName)}
        >
          {checkboxPending ? (
            <Spinner aria-hidden="true" />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Checkbox
                    aria-label={checkboxTooltip}
                    checked={checkboxChecked}
                    disabled={disabled || checkboxDisabled}
                    className={cn(selected && "border-secondary")}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={onCheckboxChange}
                  />
                }
              />
              <TooltipContent>{checkboxTooltip}</TooltipContent>
            </Tooltip>
          )}
        </ResultRowControl>
      )}
    </div>
  );
}

/** Positions an interactive row control without affecting responsive content layout. */
function ResultRowControl({ children, className }: { children: ReactElement; className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-center", className)}>{children}</span>
  );
}
