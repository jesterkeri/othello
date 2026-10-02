/**
 * Adversary pass on aed6598: projectEnvFromCli keeps a team's shared variable only when its `projectId` is an array
 * that names the project, and silently drops every other shape. A shared record whose `projectId` is not an array (a
 * bare string naming the project, null, or no field at all) is then neither read nor refused: whether it reaches the
 * project is unknown, so its name escapes the reviewed-names check and the fingerprint, where an ambiguity must fail
 * closed (the requirement: "the variable check fails closed on every ambiguity"). Stand-in runner only; Vercel is never
 * contacted.
 *
 *   npx mocha --import=tsx tests/release-deploy-shared-projectid-shape-adversary.spec.ts
 */
import assert from "node:assert/strict";

import { projectEnvFromCli, type Run } from "../ops/release-deploy.ts";

describe("projectEnvFromCli: a shared variable whose projectId is not a list (adversary pass on aed6598)", () => {
  const ids = { orgId: "team_kXXQhD4pqG6KG2NfVVFlVOHi", projectId: "prj_4f0tXAiMfVCi5qrIxJVJkT8p05Ki" };
  const ownPath = `/v10/projects/${ids.projectId}/env?teamId=${ids.orgId}`;
  const sharedPath = `/v1/env?teamId=${ids.orgId}`;
  const run = (shared: object[]): Run => async (_cmd, args) =>
    args[2] === ownPath ? { code: 0, stdout: JSON.stringify({ envs: [], hiddenProductionEnvCount: 0 }) }
      : args[2] === sharedPath ? { code: 0, stdout: JSON.stringify({ data: shared, pagination: { next: null } }) }
        : { code: 9, stdout: "" };

  it("is read or refused, never dropped", async () => {
    // control: the list shape is read, and its name reaches the check
    const listed = await projectEnvFromCli(run([{ id: "env_1", key: "NODE_OPTIONS", projectId: [ids.projectId] }]), "/x/vc.js", "/x/app", ids)();
    assert.deepEqual("names" in listed ? listed.names : listed, ["NODE_OPTIONS"]);

    for (const projectId of [ids.projectId, null, undefined]) {
      const r = await projectEnvFromCli(run([{ id: "env_1", key: "NODE_OPTIONS", projectId }]), "/x/vc.js", "/x/app", ids)();
      assert.ok("refusal" in r || r.names.includes("NODE_OPTIONS"),
        `a shared variable with projectId ${JSON.stringify(projectId)} was dropped without a refusal: ${JSON.stringify(r)}`);
    }
  });
});
