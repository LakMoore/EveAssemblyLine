"use client";

import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
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
  children,
}: ResponsiveDialogDrawerProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        {trigger && <DrawerTrigger render={trigger} />}
        <DrawerContent
          className={cn(
            "max-h-[85vh] border border-popover shadow-xl [--drawer-bleed-background:transparent] [--drawer-inset:--spacing(2)]",
            drawerClassName,
          )}
        >
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
            {headerContent}
          </DrawerHeader>
          <ScrollArea className="min-h-0 flex-1 overflow-y-auto p-4 pr-5">
            <div className="py-2">{children}</div>
          </ScrollArea>
          <DrawerFooter>{drawerFooterContent}</DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent
        className={cn("max-h-[85vh]", dialogClassName)}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
          {headerContent}
        </DialogHeader>
        <ScrollArea className="-mx-4 no-scrollbar max-h-[50vh] overflow-y-auto px-4">
          <div className="py-2">{children}</div>
        </ScrollArea>
        <DialogFooter>{dialogFooterContent}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
