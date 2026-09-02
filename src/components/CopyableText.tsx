"use client";

import type { ButtonHTMLAttributes } from "react";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type CopyableTextProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "onClick" | "type"
> & {
  textToRender: string;
  textToCopy: string;
  copyLabel?: string;
};

/** Renders text that copies a separate value when clicked. */
export default function CopyableText({
  textToRender,
  textToCopy,
  copyLabel = "Text",
  className,
  ...buttonProps
}: CopyableTextProps) {
  async function copyText() {
    try {
      await navigator.clipboard.writeText(textToCopy);
      toast.add({ description: `${copyLabel} copied` });
    }
    catch {
      toast.add({ description: `Could not copy ${copyLabel.toLowerCase()}`, type: "error" });
    }
  }

  return (
    <button
      {...buttonProps}
      type="button"
      className={cn("cursor-copy!", className)}
      onClick={() => void copyText()}
    >
      {textToRender}
    </button>
  );
}
