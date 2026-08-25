"use client";

import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type CalculateButtonProps = Omit<ComponentProps<typeof Button>, "children"> & {
  icon: LucideIcon;
  isLoading?: boolean;
  label: string;
  loadingLabel: string;
};

/**
 * Renders the shared full-width action used to start a calculation workflow.
 */
export default function CalculateButton({
  className,
  icon: Icon,
  isLoading = false,
  label,
  loadingLabel,
  disabled,
  ...props
}: CalculateButtonProps) {
  return (
    <Button
      {...props}
      className={cn(
        "h-auto min-h-14 w-full justify-between px-4 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        className,
      )}
      disabled={disabled || isLoading}
    >
      <span className="flex min-w-0 items-center gap-2 text-left">
        {isLoading ? (
          <Spinner aria-hidden="true" />
        ) : (
          <Icon data-icon="inline-start" aria-hidden="true" />
        )}
        <span className="whitespace-normal text-sm leading-tight max-[640px]:text-xs">
          {isLoading ? loadingLabel : label}
        </span>
      </span>
      <b className="text-[var(--action-accent)]" aria-hidden="true">
        →
      </b>
    </Button>
  );
}
