import type { Metadata } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';
import { THEME_STORAGE_KEY } from '@/lib/theme';
import './globals.css';

const mono = JetBrains_Mono({ variable: '--font-mono', subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  // A signed-in console: nothing here belongs in search results.
  robots: { index: false, follow: false },
};

// Runs before first paint so the saved (or system) theme applies without a flash. Dark unless the system asks for light, and the same key as stellarium.sh.
const themeScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme","dark")}})()`;

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={mono.variable} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap, no user input */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
