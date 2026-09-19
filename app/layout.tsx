import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const display = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Repo2Ready",
  description: "Paste a GitHub URL. Get a locked-down live preview.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
