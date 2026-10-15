import type { Metadata } from "next";
import { Suspense } from "react";
import { StubLab } from "./StubLab";

export const metadata: Metadata = { title: "Stub lab", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <Suspense>
      <StubLab />
    </Suspense>
  );
}
