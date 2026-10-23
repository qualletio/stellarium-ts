import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';
import { THEME_STORAGE_KEY } from '@/lib/theme';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  // A signed-in console: nothing here belongs in search results.
  robots: { index: false, follow: false },
};

// Runs before first paint so the saved (or system) theme applies without a flash. Same key as stellarium.sh.
const themeScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

/** Clerk's components (sign-in, org switcher, members) drawn with the site's tokens, so they follow the theme. */
const clerkAppearance = {
  variables: {
    colorPrimary: 'var(--button)',
    colorPrimaryForeground: 'var(--button-ink)',
    colorBackground: 'var(--paper)',
    colorForeground: 'var(--ink)',
    colorMutedForeground: 'var(--muted)',
    colorInput: 'var(--paper)',
    colorInputForeground: 'var(--ink)',
    colorBorder: 'var(--line)',
    colorDanger: 'var(--danger)',
    fontFamily: 'var(--sans)',
    borderRadius: '0',
  },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
        <head>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap, no user input */}
          <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        </head>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
