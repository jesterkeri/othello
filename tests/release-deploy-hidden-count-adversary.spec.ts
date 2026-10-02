/**
 * Adversary pass on 7afd45e (Codex r6 F2): projectEnvFromCli refuses a project list whose `hiddenProductionEnvCount` is
 * above 0, because Vercel then holds production variables this login cannot see. A project list that does not carry the
 * count at all is taken as complete: whether variables are hidden is then unknown, and an ambiguity must fail closed
 * (the requirement: "every failure or ambiguity fails closed"). The real list carries the field (`0` today), so
 * requiring it costs a normal release nothing. Stand-in runner only; Vercel is never contacted.
 *
 *   npx mocha --import=tsx tests/release-deploy-hidden-count-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { projectEnvFromCli, type Run } from "../ops/release-deploy.ts";

describe("projectEnvFromCli: a project list that does not say whether variables are hidden (adversary pass on 7afd45e)", () => {
  const ids = { orgId: "team_kXXQhD4pqG6KG2NfVVFlVOHi", projectId: "prj_4f0tXAiMfVCi5qrIxJVJkT8p05Ki" };
  const ownPath = `/v10/projects/${ids.projectId}/env?teamId=${ids.orgId}`;
  const sharedPath = `/v1/env?teamId=${ids.orgId}`;
  const run = (own: object): Run => async (_cmd, args) =>
    args[2] === ownPath ? { code: 0, stdout: JSON.stringify(own) }
      : args[2] === sharedPath ? { code: 0, stdout: JSON.stringify({ data: [], pagination: { next: null } }) }
        : { code: 9, stdout: "" };

  it("is refused like one that reports hidden variables", async () => {
    // control: the real shape, with the count at 0, is read
    const ok = await projectEnvFromCli(run({ envs: [], hiddenProductionEnvCount: 0 }), "/x/vc.js", "/x/app", ids)();
    assert.ok("names" in ok, JSON.stringify(ok));
    const hidden = await projectEnvFromCli(run({ envs: [], hiddenProductionEnvCount: 1 }), "/x/vc.js", "/x/app", ids)();
    assert.ok("refusal" in hidden, "control: a reported hidden variable is refused");

    const silent = await projectEnvFromCli(run({ envs: [] }), "/x/vc.js", "/x/app", ids)();
    assert.ok("refusal" in silent, `a project list with no hiddenProductionEnvCount was taken as complete: ${JSON.stringify(silent)}`);
  });
});
