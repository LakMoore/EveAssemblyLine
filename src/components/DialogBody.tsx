import type { ReactNode } from "react";
import { ScrollArea } from "./ui/scroll-area";

export default function DialogBody({ children }: { children: ReactNode }) {
  return <ScrollArea className="-mx-4 no-scrollbar max-h-[50vh] overflow-y-auto px-4">{children}</ScrollArea>;
}