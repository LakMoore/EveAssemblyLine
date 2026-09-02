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
import { cn } from "@/lib/utils";
import DialogBody from "./DialogBody";

export type ResponsiveDialogDrawerProps = {
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  headerContent?: ReactNode;
  drawerClassName?: string;
  drawerBodyClassName?: string;
  drawerContentClassName?: string;
  drawerFooterContent?: ReactNode;
  dialogClassName?: string;
  dialogBodyClassName?: string;
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
  drawerBodyClassName,
  drawerContentClassName,
  drawerFooterContent,
  dialogClassName,
  dialogBodyClassName,
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
            "h-[70vh] border border-popover shadow-xl [--drawer-bleed-background:transparent] [--drawer-inset:--spacing(2)]",
            drawerClassName,
          )}
        >
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
            {headerContent}
          </DrawerHeader>
          <ScrollArea className={cn("flex-1 overflow-y-auto p-4", drawerBodyClassName)}>
            <div className={cn("px-4", drawerContentClassName)}>{children}</div>
          </ScrollArea>
          {drawerFooterContent}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent className={dialogClassName}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
          {headerContent}
        </DialogHeader>
        <DialogBody className={dialogBodyClassName}>{children}</DialogBody>
        {dialogFooterContent}
      </DialogContent>
    </Dialog>
  );
}
