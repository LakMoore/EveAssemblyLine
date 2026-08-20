import type { HTMLAttributes } from "react";
import styles from "./badge.module.css";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={[styles.badge, styles[variant], className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}
