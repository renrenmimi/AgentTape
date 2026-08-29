import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider, themeScript } from "./theme-provider";

export const metadata: Metadata = {
  title: "AgentTape — replay a Claude Code session",
  description:
    "Open a Claude Code transcript that already happened and watch the messages array grow, step by step. Parsing runs entirely in the browser; nothing is uploaded.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* No-flash theme: set data-theme before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
