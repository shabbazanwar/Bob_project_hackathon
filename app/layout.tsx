import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bob Review Coach",
  description: "Paste a git diff and get an AI-powered code review.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
