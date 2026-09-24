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
  checkboxIndeterminate?: boolean;
  onCheckboxChange?: (checked: boolean) => void;
  checkboxTooltip?: string;
  checkboxPending?: boolean;
  checkboxDisabled?: boolean;
  showCheckbox?: boolean;
  installed?: boolean;
  disabled?: boolean;
  selected?: boolean;
  onClick?: () => void;
  wideBreakpoint?: "sm" | "md" | "lg";
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
  checkboxIndeterminate = false,
  onCheckboxChange,
  checkboxTooltip = "Complete result",
  checkboxPending = false,
  checkboxDisabled = false,
  showCheckbox = true,
  installed = false,
  disabled = false,
  selected = false,
  onClick,
  wideBreakpoint = "sm",
  className,
  identityClassName,
  contentClassName,
  switchClassName,
  checkboxClassName,
  ...typeIdentityProps
}: SwitchedResultRowProps) {
  const wideLayoutClasses =
    wideBreakpoint === "lg"
      ? {
          grid: "lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto] lg:items-center",
          switch: "lg:row-auto",
          identity: "lg:row-auto",
          content: "lg:col-span-1 lg:col-start-3 lg:row-auto",
          checkbox: "lg:col-start-4 lg:row-auto",
        }
      : wideBreakpoint === "md"
        ? {
            grid: "md:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto] md:items-center",
            switch: "md:row-auto",
            identity: "md:row-auto",
            content: "md:col-span-1 md:col-start-3 md:row-auto",
            checkbox: "md:col-start-4 md:row-auto",
          }
        : {
            grid: "sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto] sm:items-center",
            switch: "sm:row-auto",
            identity: "sm:row-auto",
            content: "sm:col-span-1 sm:col-start-3 sm:row-auto",
            checkbox: "sm:col-start-4 sm:row-auto",
          };
  const noSwitchLayoutClasses = {
    grid: "sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center",
    identity: "sm:row-auto",
    content: "sm:col-span-1 sm:col-start-2 sm:row-auto",
    checkbox: "col-start-2 sm:col-start-3 sm:row-auto",
  };
  const rowIsChecked = installed || checkboxChecked === true;
  const effectiveSwitchDisabled = disabled || switchDisabled || rowIsChecked;
  const effectiveCheckboxDisabled =
    disabled || checkboxDisabled || (showSwitch && switchChecked !== true);

  return (
    <div
      aria-disabled={disabled}
      data-disabled={disabled || undefined}
      data-installed={rowIsChecked || undefined}
      data-selected={selected || undefined}
      role={onClick ? "group" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `Select ${name}` : undefined}
      className={cn(
        "group/result-row grid min-h-14 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-[13px] gap-y-2 border-b border-border px-2 py-2.5 transition-colors hover:bg-muted/50 data-[disabled=true]:pointer-events-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[installed=true]:hover:bg-transparent data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:hover:bg-accent",
        showSwitch ? wideLayoutClasses.grid : "grid-cols-[minmax(0,1fr)_auto]",
        showSwitch ? undefined : noSwitchLayoutClasses.grid,
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
        <ResultRowControl
          className={cn(
            "col-start-1 row-start-1",
            wideLayoutClasses.switch,
            switchPending && "w-8",
            switchClassName,
          )}
        >
          {switchPending ? (
            <span className="flex w-8 items-center justify-center">
              <Spinner aria-hidden="true" />
            </span>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Switch
                    aria-label={switchTooltip}
                    checked={switchChecked}
                    disabled={effectiveSwitchDisabled}
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
          "col-start-2 row-start-1 min-w-0",
          showSwitch ? wideLayoutClasses.identity : noSwitchLayoutClasses.identity,
          !showSwitch && "col-start-1",
          "group-data-[installed=true]/result-row:opacity-50",
          identityClassName,
        )}
      />
      <div
        className={cn(
          "col-span-2 col-start-2 row-start-2 flex min-w-0 items-center justify-end gap-1",
          showSwitch ? wideLayoutClasses.content : noSwitchLayoutClasses.content,
          !showSwitch && "col-span-1 col-start-1",
          "group-data-[installed=true]/result-row:opacity-50",
          contentClassName,
        )}
      >
        {children}
      </div>
      {showCheckbox && (
        <ResultRowControl
          className={cn(
            "col-start-3 row-start-1",
            showSwitch ? wideLayoutClasses.checkbox : noSwitchLayoutClasses.checkbox,
            checkboxClassName,
          )}
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
                    indeterminate={checkboxIndeterminate}
                    disabled={effectiveCheckboxDisabled}
                    className={cn(
                      selected && "border-secondary",
                      checkboxIndeterminate
                        && "before:absolute before:h-px before:w-2 before:bg-current before:content-[''] data-indeterminate:[&>span>svg]:hidden",
                    )}
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
