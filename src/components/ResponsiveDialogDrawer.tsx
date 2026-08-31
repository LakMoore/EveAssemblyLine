"use client";

import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import DialogBody from "./DialogBody";

export type ResponsiveDialogDrawerProps = {
  trigger: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  headerContent?: ReactNode;
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
  title,
  description,
  headerContent,
  children,
}: ResponsiveDialogDrawerProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer>
        <DrawerTrigger render={trigger} />
        <DrawerContent className="data-[swipe-direction=down]:rounded-[min(var(--radius-4xl),24px)] border border-popover shadow-xl [--drawer-bleed-background:transparent] [--drawer-inset:--spacing(2)]">
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
            {headerContent}
          </DrawerHeader>
          <ScrollArea className="min-h-0 min-w-0 max-h-[calc(100dvh-6rem)] flex-1 overflow-y-auto">
            <div className="px-4">{children}</div>
          </ScrollArea>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
          {headerContent}
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
