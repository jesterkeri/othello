// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CircleMath} from "./CircleMath.sol";

/// The one factory function a circle calls (ARB r10).
interface IJoinRegistry {
    function recordJoin(address member) external;
}

/// @title OthelloCircle
/// @notice One rotating savings circle on Robinhood Chain, saved and collateralised in USDG only.
/// Rules: ARB-DESIGN r10 (r9 Codex SHIP plus the r10 member index), which ports SPEC sections 4 to 7 and the P1
/// delinquency latch.
/// No owner, no admin, no upgrade, no pause, no ETH. `creator` may only activate or cancel while Forming.
contract OthelloCircle is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types
    struct Params {
        uint256 n;
        uint256 c;
        uint256 g;
        uint256 minStockCover;
        uint256 haircutBps;
        uint256 coverageBps;
        uint256 warnBps;
        uint256 roundSecs;
        uint256 graceSecs;
    }

    struct Seat {
        uint256 collateral;
        uint256 g;
        uint256 topUps;
        uint256 forfeited;
        uint256 allocated;
        uint32 lastCoverageBps;
        uint16 delinquentMarks;
        uint8 roundsPaid;
    }

    enum Status {
        Forming,
        Active,
        Completed,
        Cancelled
    }

    // ------------------------------------------------------------------ bounds (ARB section 2)
    uint256 internal constant MAX_SEATS = 8;
    uint256 internal constant MAX_AMOUNT = 1e13;

    // ------------------------------------------------------------------ errors (names are SPEC/P1 machine names)
    error InvalidParams();
    error CircleNotForming();
    error CircleNotActive();
    error NotAMember();
    error AlreadyJoined();
    error NotJoined();
    error CollateralBelowMinimum(uint256 cover, uint256 minimum);
    error InsufficientBalance(uint256 needed, uint256 balance);
    error InsufficientAllowance(uint256 needed, uint256 allowance);
    error Unauthorized();
    error NotAllJoined();
    error AlreadyDefaulted();
    error AlreadyContributed();
    error RoundNotFunded(uint8 missingSeats, uint256 escrow, uint256 escrowNeeded, uint256 escrowDeficit, uint256 shortBy);
    error CoverageTooLow(
        uint256 needed,
        uint256 remaining,
        uint256 shortBy,
        uint256 recipientGap,
        uint256 othersNeed,
        uint256 escrowDeficit,
        uint256 recipientCover
    );
    error ReserveOvercommitted(
        uint256 needed,
        uint256 remaining,
        uint256 shortBy,
        uint256 recipientGap,
        uint256 othersNeed,
        uint256 escrowDeficit,
        uint256 recipientCover
    );
    error GraceNotElapsed(uint256 opensAfter);
    error SeatAlreadyPaid();
    error AlreadyMarked();
    error PrePayoutDefaultUnsupported();
    error NotMarked();
    error DefaultOutOfOrder(uint8 earlierTurn);
    error NotFinished();
    error AlreadyWithdrawn();
    error TopUpFillChanged(uint256 expectedFill, uint256 actualFill);
    error TransferAmountMismatch(uint256 expected, uint256 actual);

    // ------------------------------------------------------------------ events (Solana names)
    event MemberJoined(address indexed wallet, uint8 turn, uint256 collateral, uint256 guarantee);
    event MemberLeftForming(address indexed wallet, uint8 turn, uint256 returned);
    event CircleCancelled(uint8 joinedBitmap);
    event CircleActivated(uint8 round, uint256 roundDeadline, uint256 reserveTotal);
    event Contributed(address indexed wallet, uint8 turn, uint8 round, uint256 amount);
    event PotReleased(uint8 round, address indexed recipient, uint256 pot, uint256 needed, uint256 remaining);
    event CoverageUpdated(uint8 round, uint256 reserveAllocated, uint256 nextGateShortBy, uint256 lastCoverageAt);
    event MemberMarkedDelinquent(uint8 round, uint8 turn, bool postPayout);
    event DefaultDeclared(uint8 turn, uint256 obligation, uint256 seized, uint256 loss, uint256 deficitAdded);
    event StockAdded(address indexed wallet, uint8 turn, uint256 amount);
    event ReserveToppedUp(address indexed wallet, uint8 turn, uint256 amount, uint256 fill);
    event Withdrawn(address indexed wallet, uint8 turn, uint256 collateralPart, uint256 pooledPart);

    // ------------------------------------------------------------------ configuration (immutable)
    IERC20 public immutable usdg;
    address public immutable factory;
    address public immutable creator;
    uint256 public immutable n;
    uint256 public immutable c;
    uint256 public immutable g;
    uint256 public immutable minStockCover;
    uint256 public immutable haircutBps;
    uint256 public immutable coverageBps;
    uint256 public immutable warnBps;
    uint256 public immutable roundSecs;
    uint256 public immutable graceSecs;
    address[8] internal _members;

    // ------------------------------------------------------------------ state
    Status public status;
    uint8 public round;
    uint8 public paidBitmap;
    uint8 public joinedBitmap;
    uint8 public withdrawnBitmap;
    uint8 public receivedBitmap;
    uint8 public defaultedBitmap;
    uint8 public delinquentBitmap;
    uint256 public deadline;
    uint256 public reserveTotal;
    uint256 public reserveLosses;
    uint256 public reserveAllocated;
    uint256 public escrow;
    uint256 public escrowDeficit;
    uint256 public withdrawnFromReserve;
    uint256 public collateralReturned;
    uint256 public depositsTotal;
    uint256 public forfeitedTotal;
    uint256 public nextGateShortBy;
    uint256 public heldContributions;
    uint256 public lastCoverageAt;
    Seat[8] internal _seats;

    /// @dev Called only by OthelloFactory, which has already validated `p` and `members_`
    /// (ARB section 4.2). The constructor re-derives nothing and trusts no caller-held authority:
    /// No function compares against `factory`; the circle's only call to it is recordJoin in joinAndLock (ARB r10).
    constructor(Params memory p, address[] memory members_, address creator_, IERC20 usdg_) {
        usdg = usdg_;
        factory = msg.sender;
        creator = creator_;
        n = p.n;
        c = p.c;
        g = p.g;
        minStockCover = p.minStockCover;
        haircutBps = p.haircutBps;
        coverageBps = p.coverageBps;
        warnBps = p.warnBps;
        roundSecs = p.roundSecs;
        graceSecs = p.graceSecs;
        for (uint256 i = 0; i < members_.length; ++i) {
            _members[i] = members_[i];
        }
    }

    // ------------------------------------------------------------------ views
    function members(uint256 t) external view returns (address) {
        return _members[t];
    }

    function seat(uint256 t) external view returns (Seat memory) {
        return _seats[t];
    }

    /// Sum of every bucket the circle owes (ARB section 3.1). balanceOf(this) >= accounted() always (INV-C2).
    function accounted() public view returns (uint256 total) {
        total = reserveTotal - reserveLosses + escrow + heldContributions - withdrawnFromReserve;
        for (uint256 t = 0; t < MAX_SEATS; ++t) {
            total += _seats[t].collateral;
        }
    }

    /// Value and haircut value of a USDG collateral amount (1:1).
    function quote(uint256 amount) external view returns (uint256 value, uint256 h) {
        if (amount > MAX_AMOUNT) revert InvalidParams();
        return (amount, CircleMath.haircutValue(amount, haircutBps));
    }

    // ------------------------------------------------------------------ Forming
    function joinAndLock(uint256 amount) external nonReentrant {
        if (status != Status.Forming) revert CircleNotForming();
        uint8 t = _memberSeat();
        if (_bit(joinedBitmap, t)) revert AlreadyJoined();
        if (amount < 1 || amount > MAX_AMOUNT) revert InvalidParams();
        uint256 h = CircleMath.haircutValue(amount, haircutBps);
        if (h < minStockCover) revert CollateralBelowMinimum(h, minStockCover);
        uint256 x = amount + g;
        _checkPull(x);

        Seat storage s = _seats[t];
        s.collateral = amount;
        s.g = g;
        joinedBitmap |= uint8(1 << t);
        reserveTotal += g;
        depositsTotal += g;

        _pull(x);
        IJoinRegistry(factory).recordJoin(msg.sender);
        emit MemberJoined(msg.sender, t, amount, g);
    }

    function leaveForming() external nonReentrant {
        if (status != Status.Forming) revert CircleNotForming();
        uint8 t = _memberSeat();
        if (!_bit(joinedBitmap, t)) revert NotJoined();

        Seat storage s = _seats[t];
        uint256 x = s.collateral + s.g + s.topUps;
        reserveTotal -= s.g + s.topUps;
        depositsTotal -= s.g + s.topUps;
        delete _seats[t];
        joinedBitmap &= ~uint8(1 << t);

        _push(msg.sender, x);
        emit MemberLeftForming(msg.sender, t, x);
    }

    function cancelCircle() external nonReentrant {
        if (status != Status.Forming) revert CircleNotForming();
        if (msg.sender != creator) revert Unauthorized();
        status = Status.Cancelled;
        emit CircleCancelled(joinedBitmap);
    }

    function activate() external nonReentrant {
        if (status != Status.Forming) revert CircleNotForming();
        if (msg.sender != creator) revert Unauthorized();
        if (joinedBitmap != uint8((1 << n) - 1)) revert NotAllJoined();
        status = Status.Active;
        round = 0;
        deadline = block.timestamp + roundSecs;
        emit CircleActivated(0, deadline, reserveTotal);
    }

    // ------------------------------------------------------------------ Active
    function contribute() external nonReentrant {
        if (status != Status.Active) revert CircleNotActive();
        uint8 t = _memberSeat();
        if (_bit(defaultedBitmap, t)) revert AlreadyDefaulted();
        if (_bit(paidBitmap, t)) revert AlreadyContributed();
        _checkPull(c);

        paidBitmap |= uint8(1 << t);
        _seats[t].roundsPaid += 1;
        heldContributions += c;

        _pull(c);
        emit Contributed(msg.sender, t, round, c);
    }

    function releasePot() external nonReentrant {
        if (status != Status.Active) revert CircleNotActive();
        uint256 n_ = n;
        uint256 c_ = c;
        uint8 missing;
        uint256 k;
        for (uint8 t = 0; t < n_; ++t) {
            bool paid = _bit(paidBitmap, t);
            bool dflt = _bit(defaultedBitmap, t);
            if (!paid && !dflt) ++missing;
            if (dflt && !paid) ++k;
        }
        if (missing > 0 || escrow < k * c_) {
            revert RoundNotFunded(missing, escrow, k * c_, escrowDeficit, nextGateShortBy);
        }

        uint8 r = round;
        uint256[8] memory obl;
        uint256[8] memory hs;
        uint256[8] memory needs;
        bool[8] memory inGate;
        uint256 sum;
        for (uint8 t = 0; t < n_; ++t) {
            if (_bit(defaultedBitmap, t)) continue;
            if (_bit(receivedBitmap, t) || t == r) {
                obl[t] = c_ * (n_ - _seats[t].roundsPaid);
                hs[t] = CircleMath.haircutValue(_seats[t].collateral, haircutBps);
                needs[t] = CircleMath.need(obl[t], coverageBps, hs[t]);
                inGate[t] = true;
                sum += needs[t];
            }
        }
        uint256 avail = reserveTotal - reserveLosses;
        if (sum > avail) {
            uint256 shortBy = sum - avail + escrowDeficit;
            if (hs[r] < minStockCover && sum - needs[r] <= avail) {
                revert CoverageTooLow(sum, avail, shortBy, needs[r], sum - needs[r], escrowDeficit, hs[r]);
            }
            revert ReserveOvercommitted(sum, avail, shortBy, needs[r], sum - needs[r], escrowDeficit, hs[r]);
        }

        // Effects: escrow pays each defaulted, unpaid seat's contribution.
        for (uint8 t = 0; t < n_; ++t) {
            if (_bit(defaultedBitmap, t) && !_bit(paidBitmap, t)) {
                escrow -= c_;
                paidBitmap |= uint8(1 << t);
                _seats[t].roundsPaid += 1;
            }
        }
        for (uint8 t = 0; t < n_; ++t) {
            Seat storage s = _seats[t];
            if (inGate[t]) {
                s.allocated = needs[t];
                s.lastCoverageBps = CircleMath.coverageBps(hs[t], needs[t], obl[t]);
            } else {
                s.allocated = 0;
            }
        }
        reserveAllocated = sum;
        receivedBitmap |= uint8(1 << r);
        uint256 pot = n_ * c_;
        if (r + 1 < n_) {
            round = r + 1;
            deadline = block.timestamp + roundSecs;
            paidBitmap = 0;
            delinquentBitmap = 0;
            heldContributions = 0;
            uint256 sNext = _sNext(round);
            nextGateShortBy = (sNext > avail ? sNext - avail : 0) + escrowDeficit;
        } else {
            status = Status.Completed;
            heldContributions = 0;
            nextGateShortBy = 0;
        }

        _push(_members[r], pot);
        emit PotReleased(r, _members[r], pot, sum, avail);
    }

    function updateCoverage() external nonReentrant {
        if (status != Status.Active) revert CircleNotActive();
        _recomputeCoverage();
        emit CoverageUpdated(round, reserveAllocated, nextGateShortBy, lastCoverageAt);
    }

    function markDelinquent(uint8 round_, uint8 turn) external nonReentrant {
        if (status != Status.Active) revert CircleNotActive();
        if (round_ != round || turn >= n) revert InvalidParams();
        uint256 opens = deadline + graceSecs;
        if (!(block.timestamp > opens)) revert GraceNotElapsed(opens);
        if (_bit(paidBitmap, turn)) revert SeatAlreadyPaid();
        if (_bit(defaultedBitmap, turn)) revert AlreadyDefaulted();
        if (_bit(delinquentBitmap, turn)) revert AlreadyMarked();

        delinquentBitmap |= uint8(1 << turn);
        _seats[turn].delinquentMarks += 1;
        emit MemberMarkedDelinquent(round_, turn, _bit(receivedBitmap, turn));
    }

    function declareDefault(uint8 turn) external nonReentrant {
        if (status != Status.Active) revert CircleNotActive();
        if (turn >= n) revert InvalidParams();
        uint256 opens = deadline + graceSecs;
        if (!(block.timestamp > opens)) revert GraceNotElapsed(opens);
        if (_bit(paidBitmap, turn)) revert SeatAlreadyPaid();
        if (!_bit(receivedBitmap, turn)) revert PrePayoutDefaultUnsupported();
        if (_bit(defaultedBitmap, turn)) revert AlreadyDefaulted();
        if (!_bit(delinquentBitmap, turn)) revert NotMarked();
        for (uint8 j = 0; j < turn; ++j) {
            if (
                _bit(delinquentBitmap, j) && _bit(receivedBitmap, j) && !_bit(paidBitmap, j)
                    && !_bit(defaultedBitmap, j)
            ) revert DefaultOutOfOrder(j);
        }

        // ARB section 3.4: OneToOne seizure inside the circle; no token moves.
        Seat storage s = _seats[turn];
        uint256 o = c * (n - s.roundsPaid);
        uint256 seized = s.collateral < o ? s.collateral : o;
        s.collateral -= seized;
        uint256 shortfall = o - seized;
        uint256 free = reserveTotal - reserveLosses;
        uint256 loss = shortfall < free ? shortfall : free;
        reserveLosses += loss;
        escrow += seized + loss;
        escrowDeficit += shortfall - loss;
        uint256 cap = s.g + s.topUps;
        uint256 newForfeited = shortfall < cap ? shortfall : cap;
        forfeitedTotal = forfeitedTotal + newForfeited - s.forfeited;
        s.forfeited = newForfeited;
        defaultedBitmap |= uint8(1 << turn);
        s.allocated = 0;
        _recomputeCoverage();

        emit DefaultDeclared(turn, o, seized, loss, shortfall - loss);
    }

    function addStock(uint256 amount) external nonReentrant {
        (bool found, uint8 t) = _findSeat(msg.sender);
        bool formingJoined = status == Status.Forming && found && _bit(joinedBitmap, t);
        if (!(status == Status.Active || formingJoined)) revert CircleNotActive();
        if (!found) revert NotAMember();
        if (_bit(defaultedBitmap, t)) revert AlreadyDefaulted();
        Seat storage s = _seats[t];
        if (amount < 1 || s.collateral + amount > MAX_AMOUNT) revert InvalidParams();
        _checkPull(amount);

        s.collateral += amount;

        _pull(amount);
        emit StockAdded(msg.sender, t, amount);
    }

    /// @notice Top up the shared reserve. `expectedFill` must equal the part of `amount` that will pay
    /// other members' missed payments (min(escrowDeficit, amount)) at execution, else TopUpFillChanged.
    /// EVM-I24: the subsidy applied is always exactly the number the signer saw.
    function topUpReserve(uint256 amount, uint256 expectedFill) external nonReentrant {
        if (status != Status.Active) revert CircleNotActive();
        uint8 t = _memberSeat();
        if (_bit(defaultedBitmap, t)) revert AlreadyDefaulted();
        Seat storage s = _seats[t];
        if (amount < 1 || s.topUps + amount > MAX_AMOUNT) revert InvalidParams();
        uint256 fill = escrowDeficit < amount ? escrowDeficit : amount;
        if (fill != expectedFill) revert TopUpFillChanged(expectedFill, fill);
        _checkPull(amount);

        uint256 v = nextGateShortBy;
        uint256 d = escrowDeficit;
        escrow += fill;
        escrowDeficit = d - fill;
        reserveTotal += amount - fill;
        s.topUps += amount;
        depositsTotal += amount;
        nextGateShortBy = CircleMath.shortByAfterTopUp(v, d, amount, fill);

        _pull(amount);
        emit ReserveToppedUp(msg.sender, t, amount, fill);
    }

    // ------------------------------------------------------------------ Completed / Cancelled
    function withdraw() external nonReentrant {
        if (status != Status.Completed && status != Status.Cancelled) revert NotFinished();
        uint8 t = _memberSeat();
        if (status == Status.Cancelled && !_bit(joinedBitmap, t)) revert NotJoined();
        if (_bit(withdrawnBitmap, t)) revert AlreadyWithdrawn();

        withdrawnBitmap |= uint8(1 << t);
        Seat storage s = _seats[t];
        uint256 collateralPart = s.collateral;
        uint256 pooledPart;
        if (status == Status.Cancelled) {
            pooledPart = s.g + s.topUps;
        } else {
            uint256 poolLeft = reserveTotal - reserveLosses + escrow;
            uint256 weight = s.g + s.topUps - s.forfeited;
            pooledPart = CircleMath.pooledShare(poolLeft, weight, depositsTotal - forfeitedTotal);
        }
        withdrawnFromReserve += pooledPart;
        collateralReturned += collateralPart;
        s.collateral = 0;

        _push(msg.sender, collateralPart + pooledPart);
        emit Withdrawn(msg.sender, t, collateralPart, pooledPart);
    }

    // ------------------------------------------------------------------ internals
    function _recomputeCoverage() internal {
        uint256 n_ = n;
        uint256 remaining = reserveTotal - reserveLosses;
        uint256 sum;
        for (uint8 t = 0; t < n_; ++t) {
            Seat storage s = _seats[t];
            if (_bit(defaultedBitmap, t)) {
                s.allocated = 0;
                s.lastCoverageBps = CircleMath.U32_MAX;
                continue;
            }
            uint256 o = _bit(receivedBitmap, t) ? c * (n_ - s.roundsPaid) : 0;
            uint256 h = CircleMath.haircutValue(s.collateral, haircutBps);
            uint256 nd = CircleMath.need(o, coverageBps, h);
            uint256 a = nd < remaining ? nd : remaining;
            s.allocated = a;
            remaining -= a;
            sum += a;
            s.lastCoverageBps = CircleMath.coverageBps(h, a, o);
        }
        reserveAllocated = sum;
        uint256 avail = reserveTotal - reserveLosses;
        uint256 sNext = _sNext(round);
        nextGateShortBy = (sNext > avail ? sNext - avail : 0) + escrowDeficit;
        lastCoverageAt = block.timestamp;
    }

    /// Gate sum the next payout will see once every seat has paid (SPEC update_coverage, r4).
    function _sNext(uint8 r) internal view returns (uint256 total) {
        uint256 n_ = n;
        uint256 o = c * (n_ - r - 1);
        for (uint8 t = 0; t < n_; ++t) {
            if (_bit(defaultedBitmap, t)) continue;
            if (_bit(receivedBitmap, t) || t == r) {
                total += CircleMath.need(o, coverageBps, CircleMath.haircutValue(_seats[t].collateral, haircutBps));
            }
        }
    }

    function _findSeat(address who) internal view returns (bool, uint8) {
        uint256 n_ = n;
        for (uint8 t = 0; t < n_; ++t) {
            if (_members[t] == who) return (true, t);
        }
        return (false, 0);
    }

    function _memberSeat() internal view returns (uint8) {
        (bool found, uint8 t) = _findSeat(msg.sender);
        if (!found) revert NotAMember();
        return t;
    }

    function _bit(uint8 bitmap, uint8 t) internal pure returns (bool) {
        return (bitmap >> t) & 1 == 1;
    }

    function _checkPull(uint256 x) internal view {
        uint256 bal = usdg.balanceOf(msg.sender);
        if (bal < x) revert InsufficientBalance(x, bal);
        uint256 allow = usdg.allowance(msg.sender, address(this));
        if (allow < x) revert InsufficientAllowance(x, allow);
    }

    /// Inbound: exact delta on the circle's balance (ARB section 3.2).
    function _pull(uint256 x) internal {
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), x);
        uint256 got = usdg.balanceOf(address(this)) - before;
        if (got != x) revert TransferAmountMismatch(x, got);
    }

    /// Outbound: exact delta on both the circle and the recipient (ARB section 3.2).
    function _push(address to, uint256 x) internal {
        if (x == 0) return;
        uint256 selfBefore = usdg.balanceOf(address(this));
        uint256 toBefore = usdg.balanceOf(to);
        usdg.safeTransfer(to, x);
        uint256 sent = selfBefore - usdg.balanceOf(address(this));
        if (sent != x) revert TransferAmountMismatch(x, sent);
        uint256 received = usdg.balanceOf(to) - toBefore;
        if (received != x) revert TransferAmountMismatch(x, received);
    }
}
