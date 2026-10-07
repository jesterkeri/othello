"use client";

/** The close-out panel moved to components/circle-page (the shared circle page); this is it in Robinhood's words. */
import SharedCloseOutPanel from "@/components/circle-page/CloseOutPanel";
import { RH_WORDS, type CloseOut } from "@/lib/robinhood/circle-view";

export default function CloseOutPanel(props: { close: CloseOut; completed: boolean; canWrite: boolean; blocker: string | null; busy: boolean; onWithdraw: () => void }) {
  return <SharedCloseOutPanel words={RH_WORDS} {...props} />;
}
