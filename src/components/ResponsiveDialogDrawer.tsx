"use client";

import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

export type ResponsiveDialogDrawerProps = {
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  headerContent?: ReactNode;
  drawerClassName?: string;
  drawerFooterContent?: ReactNode;
  dialogClassName?: string;
  dialogFooterContent?: ReactNode;
  scrollToBottomKey?: string | number | boolean;
  children: ReactNode;
};

/** Tracks the viewport breakpoint used by the responsive Dialog/Drawer pair. */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);
    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);
    return () => mediaQuery.removeEventListener("change", updateIsMobile);
  }, []);

  return isMobile;
}

/** Renders the same content as a desktop Dialog and a mobile bottom Drawer. */
export default function ResponsiveDialogDrawer({
  trigger,
  open,
  onOpenChange,
  title,
  description,
  headerContent,
  drawerClassName,
  drawerFooterContent,
  dialogClassName,
  dialogFooterContent,
  scrollToBottomKey,
  children,
}: ResponsiveDialogDrawerProps) {
  const isMobile = useIsMobile();
  const scrollAreaContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollToBottomKey) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = scrollAreaContainerRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isMobile, scrollToBottomKey]);

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        {trigger && <DrawerTrigger render={trigger} />}
        {/* Constrain height (h-full) makes the ScrollArea work */}
        <DrawerContent
          className={cn(
            "h-full max-h-[85vh] min-h-[5vh] border border-popover shadow-xl [--drawer-bleed-background:transparent] [--drawer-inset:--spacing(2)]",
            drawerClassName,
          )}
        >
          <DrawerHeader className="shrink-0">
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
            {headerContent}
          </DrawerHeader>
          <ScrollArea ref={scrollAreaContainerRef} className="overflow-y-auto p-4">
            {children}
          </ScrollArea>
          <DrawerFooter className="shrink-0">{drawerFooterContent}</DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent className={cn("max-h-[85vh]", dialogClassName)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
          {headerContent}
        </DialogHeader>
        <div ref={scrollAreaContainerRef} className="min-h-0">
          <ScrollArea className="size-full max-h-[50vh] overflow-y-auto pr-3">
            {children}
          </ScrollArea>
        </div>
        <DialogFooter>{dialogFooterContent}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
