import { Suspense } from "react";
import { Terminal } from "../../components/terminal";

export default function TerminalPage() {
  return (
    <Suspense>
      <Terminal />
    </Suspense>
  );
}
