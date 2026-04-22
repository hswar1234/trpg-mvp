import type { Metadata } from 'next';
import { Cinzel, Manrope } from 'next/font/google';
import './globals.css';

const titleFont = Cinzel({
  subsets: ['latin'],
  variable: '--font-title',
  weight: ['500', '700'],
});

const bodyFont = Manrope({
  subsets: ['latin'],
  variable: '--font-body',
  weight: ['400', '500', '700'],
});

export const metadata: Metadata = {
  title: 'Chronicle Forge MVP',
  description: 'LLM 기반 온라인 멀티플레이 TRPG 보드게임 MVP',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${titleFont.variable} ${bodyFont.variable}`}>
      <body>{children}</body>
    </html>
  );
}
