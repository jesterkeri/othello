# Open questions

Mark `BLOCKING` if the merge should not proceed without an answer.

- [ ] Clock warp in tests: LiteSVM or bankrun with anchor 1.1.x (gate 1 decides; record as ADR-011 via the design session)
      P1 ANSWERED THE BUILD HALF, 2026-09-22: bankrun (`solana-bankrun` 0.4.0). It
      loads the real NFLXx mint at its canonical address byte for byte and places the
      Clock on 1763337299 and 1763337300 exactly, with the program reading each back
      (`pnpm run test:p1`). LiteSVM was tried first, since anchor-cli 1.1.2's own
      template ships it: in this repo's install it aborts the process with
      `std::bad_alloc` shortly after the first transaction that invokes the loaded
      program, 0 of 8 runs surviving. That is NOT a property of LiteSVM. The adversary
      pass ran the same workload in a separate worktree on 0.5.0/0.7.0/0.8.0 and it
      completed; one identical probe run against both installs gave 5/5 survival there
      and 0/5 here, with byte-identical litesvm-linux-x64-gnu@0.8.0 binaries. So the
      choice rests on reliability observed here, not on a proven LiteSVM defect, and
      the ADR should say so. NOTE: this line says ADR-011, but ADR-011 is already
      Jupiter price units (SPEC 9b.2), so that number is stale. The build does not
      write ADRs; the design session picks the number and writes it.
- [ ] Real CU of release_pot / update_coverage with n = 8 (NFR-3 assumes ≤ 60k)
- [ ] Program binary size vs 2.5 devnet SOL (deploy with `--max-len`; faucet top-up)
- [x] RESOLVED 2026-09-22 by Joshua: **devnet**. Original question: network. Devnet mirror /
      mainnet fork / mainnet.
      CONSEQUENCE, from ADR-012's own consequences section and not a new objection: "on
      devnet the real addresses cannot exist, so a devnet deploy would need a mirror mint
      and a separate allowlist entry, labelled as such." So devnet costs three things.
      (a) Mirror mints. The four allowlisted addresses are mainnet-only, so on devnet the
          program would refuse every mint with `mint_not_allowed`. Devnet needs Token-2022
          mints carrying a ScaledUiAmountConfig, created by the admin, plus a separate
          allowlist entry for them. ADR-012 requires that entry be LABELLED as mirrors, and
          the site must say the demo trades mirrors, not real xStocks.
      (b) A second allowlist path. `allowlist.rs` currently holds four mainnet consts. It
          needs a devnet set that cannot be confused with them: a cargo feature or a
          const chosen by cluster, never both lists live at once.
      (c) The real data stays visible. ADR-007 already routes live mainnet prices through
          /api/live, display only, so the Stock and Split lab places can show the real
          NFLXx split while the program runs on mirrors. That is what keeps the demo
          honest rather than invented.
      Neither (a) nor (b) blocks gate 2. Both block T23.
- [ ] Program-level mint allowlist: hardcoded constant or admin-managed account (ADR-012 prefers a hardcoded const list for the hackathon)
- [x] RESOLVED 2026-09-21 by the design owner: Backed's HTTPS product-page assertion
      is accepted as the trust root, and SPYx and NVDAx are recorded in SPEC 9b.1 with
      the root stated in SPEC 9b.6. The four-fixture contract stands unchanged.
      Original question: what is the trust root for the SPYx and
      NVDAx mint addresses? They are not in SPEC 9b.1, unlike AAPLx and NFLXx. Codex
      round 2 established that NOTHING on-chain can establish issuer identity: the
      scaled-UI authority and the metadata update authority are both non-signer
      instruction data, so a counterfeit mint can carry Backed's public keys without
      holding them, and the metadata URI is attacker-chosen. The strongest binding
      available is Backed's own product page fetched over TLS at a URL this repo
      derives from the symbol, which is now enforced per fetch. That makes the trust
      root backed.fi's TLS and DNS, plus Joshua's reading of that page. Decide: accept
      that root and record SPYx/NVDAx in SPEC 9b.1, or restrict gate 1 to the two
      SPEC-pinned mints. This is a design decision, not a build one.
- [ ] RPC transport is pinned to https + api.mainnet-beta.solana.com, because a
      genesis hash is public and authenticates nobody. A paid provider will need
      adding to TRUSTED_RPC_HOSTS as an explicit decision, not an env override.
- [ ] Test runner: ARCHITECTURE's repository layout names ts-mocha, and T01 uses
      mocha with the tsx loader (`mocha --import=tsx`) instead. The repo is ESM
      (`"type": "module"`, `ops/*.ts` importing `./issuer.ts`), and ts-mocha drives
      ts-node's CommonJS path, which does not load those imports. Same runner, same
      spec files, different loader. Not blocking; recorded because ARCHITECTURE is
      owned by the design session and the build must not edit it.
- [ ] T08 SCOPE RESOLVED 2026-09-22, the rest still open. This entry used to block T08,
      on the reasoning that create_circle is the first task the solo ruling would
      invalidate. The ruling came back and it does not: Joshua chose solo as a SEPARATE
      mode funded from an admin-seeded pool, so `PROPOSAL-solo-mode.md:19` reads "the
      circle is unchanged and both modes ship", and Codex's own Open-circle entry in this
      file says it "explicitly keeps private T08 unchanged". `n: u8 // 3..=8` stands and
      create_circle is unaffected, so gate 2 proceeds. What remains open is the solo
      proposal's own design review, r4, which gates the SOLO build and nothing else.
      Original entry follows.
      DESIGN REQUEST from Joshua, 2026-09-22: add Borrow Solo. The
      build cannot act on this: SPEC, ARCHITECTURE and the ADRs are design-owned, so the
      design session rules and the pack is re-handed. Scoped to T08 because gate 1 does not
      depend on member count, so T04 to T07 continue unaffected, while T08 create_circle is
      the first task the ruling would invalidate. The design session needs these findings:
      (a) PAIRING BY PEOPLE YOU KNOW IS ALREADY THE DESIGN. ADR-003 and FLOWS D3: the creator
          names every member wallet and the turn order at create, and join_and_lock is that
          member's consent. Open join, a separate approval instruction and order voting were
          all rejected. No work is needed for the friends case.
      (b) PAIRING BY SCORE IS AN EXPLICIT NON-GOAL, twice: "cross-circle reputation (D9)" in
          SPEC:27 and SYSTEM.md:30, and FLOWS.md:14 lists "removed from future circles" as a
          no-go. A score built from how people use the app is cross-circle reputation. It
          also needs per-wallet cross-circle state, history, and an answer to Sybil: nothing
          stops one person opening ten wallets with clean scores, so a score that gates
          entry is worth less than the creator naming someone they know.
      (c) SOLO NEEDS A CAPITAL SOURCE, and that is the real question. A circle funds its
          recipient from the other members' contributions, n x c. A solo borrower has no
          other members, so the money must come from somewhere the spec does not yet have:
          an admin-seeded protocol pool, or peer lenders depositing to earn. The second is
          "generic lending", which sits next to "Borrow solo" in the same CUT list in
          FRAME.md:38. Valuation, the whole of gate 1, is shared by both modes and is
          already built, so solo is not blocked by anything technical here; it is blocked on
          naming the lender.
- [ ] DEFERRED DESIGN BACKLOG, after the current private-circle build is complete: specify an
      **Open circle** mode with system matching and persistent-identity memory. This does not
      change, delay, or retroactively reinterpret the private T08 circle: friends continue to
      form that circle themselves. Work out the Open-mode logic only after the private flow is
      built end to end. The design must keep the domains asymmetric: private completion never
      earns positive Open standing; a final, objective on-chain default may create a
      identity-bound consequence that cannot be cleared by changing wallets. Before any build,
      decide the identity-proof trust boundary and privacy model, matching epoch/randomness and
      liveness, score recovery and appeal policy, tier shortage behaviour, and the exact
      collateral/guarantee bound for every new Open participant. "High score" at entry must
      mean eligible at the conservative, fully loss-covered limit, not elevated unsecured
      credit.
- [ ] Borrow Solo history: raised 2026-09-22, relaying a planner session that believed
      it had silently dropped a solo borrowing mode. CHECKED AGAINST THE PACK, and that is
      not what happened: `design/FRAME.md:38` lists "Borrow solo" first in `## 4. Non-goals
      (from SPEC "CUT")`, and `SPEC.md:29` inherits that list. The cut is recorded, was made
      upstream in the original spec, and the pack is coherent with it everywhere (`n: u8 //
      3..=8`, create_circle refuses outside 3..=8 with invalid_params, and G2 requires that
      refusal to be tested). Nothing is half-built. Whether to RESTORE it is still Joshua's
      call, so this stays open. Cost if restored: gate 1 is untouched, because valuation does
      not depend on member count. Gate 2 is not a parameter change: at n = 1 there is no
      rotation, no turn order, no peak-guarantee check, and update_coverage has nothing to
      allocate across, so a solo borrow is a collateralised loan sharing only the valuation
      layer, which is why "generic lending" sits beside it in the same cut list. Not blocking:
      the build proceeds on the frozen spec until the design session says otherwise.
- [ ] `quote_valuation` signature: SPEC:112 writes it as `quote_valuation(raw)` with
      accounts "mint + feed", but its `h` is defined in SPEC section 4 in terms of
      `haircut_bps` and its `price_stale` refusal in terms of `max_price_age`, and
      neither is reachable from a mint or a feed: both live on `Circle`. T05 reads this
      as the pack under-listing arguments, which it does elsewhere too (TASKS:13 writes
      `set_prices(stamp, expected_multiplier_fixed)` where SPEC:113 has four arguments),
      and implements `quote_valuation(raw, haircut_bps, max_price_age)` with the accounts
      exactly as SPEC states. Not blocking, and no invariant depends on which way it is
      resolved; recorded so the design session can ratify or correct the reading.
- [ ] BLOCKING before T23 (any deploy). **Unauthenticated oracle takeover:**
      `init_price_feed` has no authority gate, and SPEC cannot currently give it one. SPEC:113 puts `init_price_feed` on the admin row
      and lists `unauthorized` among its refusals, but SPEC section 4 defines no admin or
      config account for the program to check a signer against: `PriceFeed.authority` is
      written BY that instruction, so it cannot also gate it. So today whoever calls it
      first becomes the authority for that mint, and there is no transfer or close
      instruction, so the claim is permanent. The feed PDA is `["price", stock_mint]`, one
      deterministic address per mint, so on a shared cluster a stranger can squat every
      allowlisted mint's feed before the admin does and lock the demo out. Found by the T04
      adversary pass, reproduced: a funded stranger called init_price_feed for NFLXx, the
      feed came back with the stranger as authority, and the intended admin's set_prices
      then refused `Unauthorized`.
      SEVERITY, corrected by Codex 2026-09-22: this is worse than squatting the address.
      The first caller becomes `feed.authority`, and `set_prices` only verifies the
      MULTIPLIER against the mint; `wrapper_price` and `share_price` are arbitrary beyond
      being non-zero. So the squatter sets the price every valuation reads. Through
      `quote_valuation` and, in gate 2, through coverage and the payout gate, that is
      control of what collateral is worth. Unauthenticated oracle takeover on any deployed
      cluster, not a denial of service. The build session first recorded it as griefing;
      that was too soft.

      Not exploitable in gate 1: nothing is deployed and every test creates its own feed in
      a fresh harness. It becomes real the moment anything is on a cluster, hence the T23
      scope. The build cannot fix it without inventing an account SPEC does not have.

      REQUIRED SHAPE, per Codex: a bootstrap authority root, for example a fixed
      deploy-time authority or config PDA, which `init_price_feed` must then require.
      "A first-caller-wins initializer cannot be part of the deployed trust model." The
      third option previously listed here, batching feed creation with the deploy to shrink
      the window, is therefore NOT a fix and is withdrawn: it narrows a race it cannot
      close.

      CARRIED INTO T07: the gate-1 brief must state that gate 1 is LOCALLY
      implementation-ready, not deploy-ready, so a passing gate-1 review cannot be read as
      clearing this block.
- [ ] Price freshness treats a FUTURE `updated_at` as fresh. `valuation::value_position`
      computes `age = now - feed.updated_at` and requires `age <= max_price_age`; a feed
      stamped ahead of the clock gives a negative age, which passes. Raised by the R1
      refactor pass as a suspicion and left unfixed there, because R1 must not change
      behaviour. Only `set_prices` and `touch_prices` write that field and both write
      `Clock::get()`, so it needs the validator clock to move backwards, which bankrun can
      do and a real cluster should not. SPEC §5 defines fresh as `now - updated_at <=
      max_price_age` and says nothing about the negative case. Decide whether a
      future-stamped feed is fresh, stale, or `invalid_params`; the build will implement
      whichever, and the T05 suite has a place for it.
- [ ] Gate 1 emits no events at all, and `ARCHITECTURE.md:85` requires one per state
      change: "Repudiation: an event per state change (CircleCreated, MemberJoined,
      Activated, Contributed, PotReleased, CoverageUpdated, DefaultDeclared,
      ReserveToppedUp, StockAdded, Withdrawn, PricesSet)". Found by the T08 scout pass.
      Three adversary passes and the Codex gate-1 review all missed it, because none was
      pointed at ARCHITECTURE's STRIDE table. `PricesSet` is now emitted by `set_prices`
      as part of T08's event surface; that is additive, changes no refusal and no
      arithmetic, and the gate-1 verdict predates it. Noting rather than hiding it: gate
      1 was reviewed without this event and the review is not re-run for it.
- [ ] `mint_not_allowed` is missing from SPEC section 9's error table. ADR-012 defines the
      refusal and SPEC 9b.3 requires the allowlist, but section 9's user-facing error
      contract, which the UI reads, has no row for it. The build emits the code; the copy
      for it does not exist. Design session.
- [ ] SPEC specifies no INITIAL value for most `Circle` fields: the five bitmaps, `round`,
      `round_deadline`, `escrow`, `escrow_deficit`, `withdrawn_usdc`, `deposits_total`,
      `forfeited_total`, `next_gate_short_by`, `held_contributions`, `last_coverage_at`.
      T08 sets every one to zero and `status` to Forming, which is what makes I2, I3 and
      I4 hold from the first instruction. `activate` sets `round` 0 and the deadline
      (SPEC:105), so `round_deadline` stays 0 while Forming. Recorded as a reading.
- [ ] SPEC does not say who pays rent for the `Circle` account, nor whether the circle's
      two vaults are created at create or at first join. T08 has the creator pay and
      creates both vaults at create, because I3 and I4 are stated in terms of vault
      balances and must hold after every instruction. CORRECTED 2026-09-22 while building
      T08: the vaults are created at JOIN, not at create, which is what SPEC's own pattern
      does ("creates the member's USDC ATA if missing", SPEC:102). Creating them at create
      was tried first and the real mints refused it, which is the more interesting half:

        Program log: Instruction: InitializeAccount3
        Program log: Warning: Mint has a permanent delegate, so tokens in this account
                     may be seized at any time
        Program log: Error: InvalidAccountData

      A Token-2022 account for a mint carrying extensions needs more than the base 165
      bytes and Anchor's `init` allocates the base, so T09 must size the vaults from the
      mint's required account extensions, or use the ATA program which does it. Until a
      vault exists, I3 and I4 are vacuous rather than false. ARCHITECTURE:68 sizes Circle
      at ~0.0054 SOL and the creator pays.
- [ ] KNOWN-LIMITS L7 CONFIRMED ON CHAIN, not assumed. L7 accepts that "issuer powers of
      real xStocks (pause, freeze, permanent delegate) are not handled". Token-2022 itself
      warned while initialising an account for the real NFLXx mint: "Mint has a permanent
      delegate, so tokens in this account may be seized at any time". So Backed can seize
      stock out of a circle's vault, and no instruction Othello has can stop it. L7 is
      correct as written and needs no change; this is evidence for it, and the site copy
      that states the limit can now say it is observed rather than believed.
- [x] RESOLVED 2026-09-22: the rules are now in `HACKATHON.md`, fetched from
      hackathons.solana.com. The criterion is one question, "could this be a real app that
      people will actually use?", and there is NO requirement to demonstrate correctness in
      the app, no code audit and no proof artifact. Submission needs "at least one link:
      GitHub, live demo, or video", so the submission cannot be lost, but a repo link does
      not score. Five bounties exist and Othello is eligible for none of them as built; the
      main $100k track is the target. One residue: the rules page does not state which
      network is required, so devnet is unconfirmed rather than confirmed. Check the
      submission form itself, which may ask for more than the rules page publishes.
      Original entry follows.
      THE ACTUAL STOCKLANA RULES WERE NOT IN THIS REPO.
      The only record of what is scored is `design/FRAME.md:28`, a one-line paraphrase:
      "judged on 'could this be a real app people will use', working end-to-end demo,
      reason it belongs on Solana, execution quality". That is somebody's summary, not the
      rubric. Nothing here states the required submission format, the eligibility gate, the
      weighting between criteria, whether a demo video is mandatory, whether the repo must
      be public, whether a specific track must be named, or whether any judging multiplier
      exists. Raised 2026-09-22 when Joshua asked whether an in-app correctness proof is
      required; that question cannot be answered from what is recorded.
      Get the rules, paste them in, and check the build against them line by line before
      anything else is prioritised. A missed format or multiplier has cost a finish before.
- [ ] T27 repo tidy: WHAT IS ACTUALLY DELETABLE. Joshua asked on 2026-09-22 that the
      unimportant information be removed once the build is done, because the repo becomes
      a judged artifact: `HACKATHON.md` records that a GitHub link satisfies the
      submission, so judges may read it.
      CANNOT BE DELETED WITHOUT BREAKING CI. The harness workflow's pack-integrity step
      reads `TASKS.md`, `DONE.md` and `OPEN-QUESTIONS.md`, and `scripts/check-reviews.sh`
      reads `DONE.md` and `reviews/*review*.md`. Deleting any of them fails a required
      status check and blocks the merge. If they are to go, the workflow goes first, and
      that is a security-boundary change that needs a human to approve the diff.
      SHOULD PROBABLY STAY, because it is evidence of rigour rather than clutter:
      `DONE.md`, `reviews/`, `adr/`, `INVARIANTS.md`, `SPEC.md`, `design/`. A judge asking
      "could this be a real app people will use" is not hurt by seeing four design review
      rounds and a mutation-checked decoder.
      REAL CANDIDATES, all process scaffolding rather than product: `app/HANDOFF.md` (a
      brief between two build sessions), `PROPOSAL-solo-mode.md` (a design draft for a
      mode that does not exist), the resolved entries in this file, `PREFLIGHT.md` and
      `PIPELINE.md` if they read as internal process, and `AGENTS.md`/`CLAUDE.md` if
      Joshua would rather not advertise how it was built.
      NOT THE BUILD'S CALL. Joshua approves the list before anything is deleted, and it
      lands as one commit so it can be reverted whole.

- [ ] The real xStocks carry a TransferHook extension with its program id UNSET (T09, 2026-09-23)
      Reading the committed fixtures shows all four mints carry, besides
      ScaledUiAmountConfig and TokenMetadata: PermanentDelegate, Pausable,
      DefaultAccountState, ConfidentialTransferMint and TransferHook.

      Right now none of them blocks Othello. DefaultAccountState is 1, thawed, so a
      new vault is not born frozen. Pausable's paused byte is 0. TransferHook's
      program id is all zeroes, so `transfer_checked` runs without invoking a hook.
      That is the only reason T09's plain transfer_checked works against real bytes.

      Each of those is the issuer's to change at any time, with no warning and no
      action from us. If the issuer ever sets a hook program, every Othello transfer
      of that mint fails until the program resolves the hook's extra account metas
      through `spl_transfer_hook_interface`. If they pause, or flip the default
      account state, the same. This is KNOWN-LIMITS L7 ("issuer powers not handled")
      with the specific mechanism now named rather than assumed.

      Not blocking the hackathon: the demo runs on devnet against S2's mirror mints,
      which carry only ScaledUiAmountConfig. It is a mainnet question, for the design
      session, alongside L7's "revisit at mainnet".

- [ ] bankrun's bundled Token-2022 cannot parse a real xStock (T09, 2026-09-23, RESOLVED IN THE HARNESS)
      solana-bankrun 0.4.0 embeds a Token-2022 that predates ScaledUiAmountConfig
      (extension 25) and Pausable (26). Its TLV walk errors on an unknown
      discriminant, so the program's own GetAccountDataSize returns
      InvalidAccountData against the real mint and no ATA can be created for it.

      Proved rather than inferred: a probe created an ATA for a bare Token-2022 mint
      and failed for NFLXx in the same harness run.

      Resolved by loading the real program from tests/fixtures/spl_token_2022.so,
      dumped from devnet with `solana program dump`, which is the same provenance
      rule the mint fixtures follow. Recorded because it is a standing trap: any
      future test that moves a Token-2022 token depends on that file being loaded,
      and a harness that quietly fell back to the bundled program would fail in a way
      that looks like a program defect rather than a toolchain one.

- [ ] I4's wording is externally falsifiable now the vault is an ATA (T09 adversary, 2026-09-23)
      INVARIANTS.md I4 reads "stock vault balance = sum of member.stock_raw", with no dust
      clause, unlike I3 which carries "(+ dust)". The circle's stock vault is an Associated
      Token Account, so anyone at all can transfer into it without touching Othello.

      Measured by the adversary: after putting 12,345 raw units into the vault and then joining
      with 110,000,000, the vault read 110,012,345 against a sum of member.stock_raw of
      110,000,000. No money moved wrongly, nothing the program did was incorrect, and no design
      can prevent an inbound transfer to an ATA.

      So the equality cannot hold as an equality, and a reviewer reading I4 literally would call
      T09 a violation. This is a wording fix in INVARIANTS.md, ">=" or "(+ dust)" as I3 already
      has, and INVARIANTS.md is the design session's file, not the build's. Recorded here rather
      than edited. The program is unchanged either way: it reasons from member.stock_raw, never
      from the vault balance.

- [ ] `create_circle` constrains `stock_mint` but not `usdc_mint` (T09 adversary, 2026-09-23, before T14)
      The stock mint must be on the ADR-012 allowlist. The USDC mint has no such check: it is
      pinned only by the pool PDA's seeds, which means whatever mint `init_pool` was pointed at.

      If T14's `init_pool` is ever pointed at a Token-2022 "USDC" carrying TransferFeeConfig,
      `join_and_lock` credits `reserve_total += guarantee` while the vault receives
      `guarantee - fee`. The reserve would then be larger than the money behind it, which is I3,
      and the peak-guarantee check at create time would be measuring a reserve that does not
      exist. The same applies to every later instruction that moves USDC.

      Not exploitable today: `init_pool` is admin-only and unwritten. It becomes real the moment
      T14 lands, so the check belongs in T14, either an allowlist for the USDC mint or a refusal
      of any mint carrying TransferFeeConfig. Raised as a suspicion, not a proven defect: no
      allowlisted xStock carries TransferFeeConfig, confirmed by decoding all four fixtures.
