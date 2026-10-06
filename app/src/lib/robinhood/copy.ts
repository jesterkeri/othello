/**
 * Plain-language copy for every OthelloCircle refusal, keyed by machine name (ARB-DESIGN r9 section 4.1).
 * Amounts arrive as USDG base units (6 dp). No em-dashes; the voice is Othello's.
 */
import { fmtUsdg } from "../core/money";

export { fmtUsdg };

const u = (x: unknown) => fmtUsdg(BigInt(x as bigint));

export function explainRefusal(name: string, args: readonly unknown[]): string {
  switch (name) {
    case "InvalidParams":
      return "Those numbers are outside what this circle allows.";
    case "GuaranteeBelowPeakNeed":
      return `The guarantee is too small: the circle needs ${u(args[0])} in its reserve at its busiest point and this gives ${u(args[1])}.`;
    case "CircleNotForming":
      return "This circle has already started or was cancelled, so joining and leaving are closed.";
    case "CircleNotActive":
      return "This circle isn't running right now.";
    case "NotAMember":
      return "This wallet isn't one of this circle's members. Switch to the wallet the invite was for.";
    case "AlreadyJoined":
      return "You've already joined this circle.";
    case "NotJoined":
      return "You haven't joined this circle.";
    case "CollateralBelowMinimum":
      return `That locks too little: it counts for ${u(args[0])} of cover and this circle needs ${u(args[1])}.`;
    case "InsufficientBalance":
      return `This needs ${u(args[0])} and your wallet holds ${u(args[1])}.`;
    case "InsufficientAllowance":
      return `The approval was for less than ${u(args[0])}. Try again and approve the amount shown.`;
    case "Unauthorized":
      return "Only the person who created this circle can do that.";
    case "NotAllJoined":
      return "Not every member has joined yet.";
    case "AlreadyDefaulted":
      return "This seat has already been settled as a default.";
    case "AlreadyContributed":
      return "You've already paid this round.";
    case "RoundNotFunded":
      return `The pot can't be released yet: ${String(args[0])} payment${args[0] === 1 ? " is" : "s are"} still missing this round.`;
    case "CoverageTooLow":
      return `Can't release the pot: the recipient's locked USDG counts for ${u(args[6])} of cover, below the minimum, and the reserve is ${u(args[2])} short. They can lock more, or any member can top up ${u(args[2])}.`;
    case "ReserveOvercommitted":
      return `Payouts are paused: the next payout needs ${u(args[0])} of reserve and ${u(args[1])} remains. Any member can top up ${u(args[2])} to restart it.`;
    case "GraceNotElapsed":
      return `The grace period hasn't ended. It ends at ${new Date(Number(args[0]) * 1000).toLocaleString()}.`;
    case "SeatAlreadyPaid":
      return "That member has already paid this round.";
    case "AlreadyMarked":
      return "That missed payment is already recorded.";
    case "PrePayoutDefaultUnsupported":
      return "A member who hasn't received the pot yet can't be defaulted. The circle waits until they pay.";
    case "NotMarked":
      return "Record the missed payment first, then settle it.";
    case "DefaultOutOfOrder":
      return `An earlier member (turn ${Number(args[0]) + 1}) is also late and is settled first.`;
    case "NotFinished":
      return "Withdrawals open when the circle completes or is cancelled.";
    case "AlreadyWithdrawn":
      return "You've already withdrawn from this circle.";
    case "TopUpFillChanged":
      return `The circle changed since you looked: now ${u(args[1])} of this top-up would pay for others' missed payments. Check the new amounts and sign again.`;
    case "TransferAmountMismatch":
      return "The stablecoin moved a different amount than asked, so nothing happened. The issuer may have changed how USDG works.";
    case "ReentrancyGuardReentrantCall":
      return "Another action was still running inside this circle. Try again.";
    case "WrongNetwork":
      return "Switch your wallet to Robinhood Chain testnet.";
    case "NotTrusted":
      return "This isn't an Othello circle.";
    case "UserRejected":
      return "You cancelled in your wallet. Nothing was sent.";
    default:
      return name;
  }
}
