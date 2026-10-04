import type { ReactNode } from "react";

import { RouteGate } from "@/components/othello/SideGate";

/** Every page here belongs to one chain: shown only with that chain's wallet connected (components/othello/SideGate). */
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteGate>{children}</RouteGate>;
}
