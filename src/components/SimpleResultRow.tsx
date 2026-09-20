"use client";

import type { ComponentProps, ReactNode } from "react";
import TypeIdentity from "@/components/TypeIdentity/TypeIdentity";
import { cn } from "@/lib/utils";

export type SimpleResultRowProps = Omit<
  ComponentProps<typeof TypeIdentity>,
  "name" | "typeId" | "className"
> & {
  name: string;
  typeId: number;
  children: ReactNode;
  disabled?: boolean;
  installed?: boolean;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
  identityClassName?: string;
  contentClassName?: string;
};

/** Renders a selectable type result with narrow-first responsive content. */
export default function SimpleResultRow({
  name,
  typeId,
  children,
  disabled = false,
  installed = false,
  selected = false,
  onClick,
  className,
  identityClassName,
  contentClassName,
  ...typeIdentityProps
}: SimpleResultRowProps) {
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
        "group/result-row flex min-h-14 min-w-0 flex-col gap-2 border-b border-border px-2 py-2.5 transition-colors hover:bg-muted/50 data-[disabled=true]:pointer-events-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[installed=true]:hover:bg-transparent data-[installed=true]:**:data-result-row-content:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:hover:bg-accent sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-[13px]",
        "last:border-b-0",
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
      <TypeIdentity
        {...typeIdentityProps}
        name={name}
        typeId={typeId}
        className={cn("min-w-0", identityClassName)}
      />
      <div className={cn("contents", contentClassName)}>{children}</div>
    </div>
  );
}
