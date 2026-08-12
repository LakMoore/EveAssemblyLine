import type { Metadata } from "next";
import AppShell from "./AppShell";
import { ToastProvider } from "./components/ToastProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eve AssemblyLine | EVE production control",
  description: "A production planning workspace for EVE Online.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
              try {
                if (window.matchMedia("(min-width: 901px)").matches && window.localStorage.getItem("assembly-line-sidebar-collapsed") === "false") {
                  document.documentElement.dataset.sidebarPreference = "expanded";
                }
              } catch {}
            })();`,
          }}
        />
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
