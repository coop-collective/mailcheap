import localFont from "next/font/local";
import ProviderTheme from "@/components/ProviderTheme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_NAME } from "@/lib/config";
import "./globals.css";

const geistSans = localFont({
	src: "../assets/fonts/Geist-Variable.woff2",
	variable: "--font-geist-sans",
	weight: "100 900",
	style: "normal",
});
const geistMono = localFont({
	src: "../assets/fonts/GeistMono-Variable.woff2",
	variable: "--font-geist-mono",
	weight: "100 900",
	style: "normal",
	adjustFontFallback: false,
	fallback: ["ui-monospace", "SFMono-Regular", "Roboto Mono", "Menlo", "Monaco", "Liberation Mono", "DejaVu Sans Mono", "Courier New", "monospace"],
});

// The icon files in app/ apply wherever a page sets no icons; archive pages set the newsletter's logo.
// favicon.ico sits in public/ because Next links app/favicon.ico on every page, archive pages included.
export const metadata = {
	title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
	robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
	return (
		<html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
			<body className="min-h-dvh bg-background text-foreground">
				<ProviderTheme>
					<TooltipProvider delayDuration={200}>{children}</TooltipProvider>
					<Toaster position="bottom-right" />
				</ProviderTheme>
			</body>
		</html>
	);
}
