import type { Metadata, Viewport } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppShell from "./AppShell";
import { ToastProvider } from "./components/ToastProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eve AssemblyLine | EVE production control",
  description: "A production planning workspace for EVE Online.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <TooltipProvider>
          <ToastProvider>
            <AppShell>{children}</AppShell>
          </ToastProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
