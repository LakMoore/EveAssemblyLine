import type { Metadata } from "next";
import AppShell from "./AppShell";
import { ToastProvider } from "./components/ToastProvider";
import { TooltipProvider } from "./components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eve AssemblyLine | EVE production control",
  description: "A production planning workspace for EVE Online.",
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
