import type { Metadata } from "next";
import { Suspense } from "react";
import { Terminal } from "../../components/terminal";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; q?: string }>;
}): Promise<Metadata> {
  const params = await searchParams;
  const token = params.token ?? params.q;
  const card = token && /^0x[0-9a-f]{40}$/i.test(token) ? `/api/card?token=${token}` : "/api/card";
  return {
    title: "XRAY terminal",
    description: "Six agents rebuild every holder's book and tell you who is in profit, who is underwater and whether they can trade at all.",
    openGraph: { images: [{ url: card, width: 1080, height: 1080 }] },
    twitter: { card: "summary_large_image", images: [card] },
  };
}

export default function TerminalPage() {
  return (
    <Suspense>
      <Terminal />
    </Suspense>
  );
}
