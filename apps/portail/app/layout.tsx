import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

// globals.css maps Tailwind's font-sans to --font-sans.
const sans = Geist({ variable: "--font-sans", subsets: ["latin"] });

export const metadata: Metadata = { title: "Portail" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className={sans.variable}>
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
