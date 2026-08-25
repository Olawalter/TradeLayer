import type { Metadata } from "next";
import { Archivo, Archivo_Narrow, Cormorant_Garamond, IBM_Plex_Mono } from "next/font/google";
import { WalletProvider } from "@/lib/wallet";
import { Header } from "@/components/Header";
import { Ticker } from "@/components/Ticker";
import "./globals.css";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-archivo",
  display: "swap",
});

const archivoNarrow = Archivo_Narrow({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-archivo-narrow",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TradeLayer — trust infrastructure for global trade",
  description:
    "Cross-border trade escrow settled by adjudication, not by a signature. " +
    "Both parties agree the remedy for each breach before the goods ship; a " +
    "GenLayer panel returns findings over frozen evidence and the contract does " +
    "the arithmetic.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${cormorant.variable} ${archivo.variable} ${archivoNarrow.variable} ${plexMono.variable}`}>
      <body>
        <WalletProvider>
          <div className="flex min-h-screen flex-col">
            <Header />
            <Ticker />
            <main className="flex-1">{children}</main>
            <footer className="border-t border-rule px-6 py-5 text-[11px] text-paper-faint md:px-10">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="label">TradeLayer · GenLayer StudioNet</span>
                <span className="mono">
                  Contract state is authoritative. This interface renders it and never computes settlement.
                </span>
              </div>
            </footer>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
