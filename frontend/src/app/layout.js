import "./globals.css";
import Navbar from "@/components/layout/Navbar";
import ThemeProvider from "@/components/layout/ThemeProvider";
import LanguageProvider from "@/components/layout/LanguageProvider";

export const metadata = {
  title: "Q你一下",
  description: "Create and manage music clip playlists",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="min-h-screen bg-background antialiased" style={{ color: "var(--text)" }}>
        <LanguageProvider>
          <ThemeProvider>
            <Navbar />
            <main className="mx-auto max-w-screen-2xl px-4 pb-6">{children}</main>
          </ThemeProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
