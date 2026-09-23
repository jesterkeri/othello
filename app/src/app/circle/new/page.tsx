"use client";

import { useRouter } from "next/navigation";

import Create from "@/components/othello/Create";

/**
 * The Create place, at the route Landing's "Create a circle" already pointed
 * at. That link was a real 404 until this landed.
 *
 * `onCreate` is deliberately unset: creating a circle is a transaction and
 * there is no wallet yet, so the screen shows "Connect wallet" instead of
 * "Create circle" and the form refuses to submit. That is the component's own
 * behaviour, not a stub, and it is the truth about what the app can do today.
 */
export default function CreateCirclePage() {
  const router = useRouter();

  return <Create onCancel={() => router.back()} />;
}
