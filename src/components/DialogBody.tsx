import type { ReactNode } from "react";
import { ScrollArea } from "./ui/scroll-area";

export default function DialogBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="-mx-4 no-scrollbar max-h-[calc(100dvh-8rem)] overflow-y-auto px-4">
      {children}
    </ScrollArea>
  );
}
