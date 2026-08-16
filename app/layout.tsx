import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "본심 — 사진 없는 AI 소개팅",
  description:
    "서로의 얼굴은 AI만 먼저 봅니다. AI가 외모·성격·가치관·대화 궁합을 학습해 실제로 잘 맞을 사람을 소개하는 블라인드 소개팅.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
