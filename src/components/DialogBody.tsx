import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "./ui/scroll-area";

export default function DialogBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ScrollArea
      className={cn("-mx-4 no-scrollbar max-h-[calc(100dvh-8rem)] overflow-y-auto px-4", className)}
    >
      {children}
    </ScrollArea>
  );
}
