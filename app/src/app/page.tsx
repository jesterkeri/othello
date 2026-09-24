"use client";

import { useRouter } from "next/navigation";

import Landing from "@/components/landing/Landing";
import { CONNECT_HREF } from "@/lib/nav";

export default function Page() {
  const router = useRouter();

  return (
    <Landing
      onOpenDemo={() => router.push("/circle/demo")}
      onCreateCircle={() => router.push("/circle/new")}
      onConnectWallet={() => router.push(CONNECT_HREF)}
    />
  );
}
