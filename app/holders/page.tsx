import type { Metadata } from "next";
import { Holders } from "../../components/holders";

export const metadata: Metadata = {
  title: "Xray-terminal - one wallet, read",
  description: "Paste a public address and XRAY reads its Pons record: trades, tokens, what each one made or lost. No wallet connect, no signing.",
};

export default function HoldersPage() {
  return <Holders />;
}
