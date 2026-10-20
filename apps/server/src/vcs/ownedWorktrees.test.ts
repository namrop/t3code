import { expect, test } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";

const id = ProjectId.make("owned-project");
const setup = {
  id: "setup",
  name: "Setup",
  command: "node scripts/setup-worktree.ts",
  icon: "configure" as const,
  runOnWorktreeCreate: true,
};
test("enrollment follows the same project and environment script overrides as setup", async () => {
  const Owned = await import("./ownedWorktrees.ts").catch(() => null);
  expect(Owned, "enrollment resolver exists").not.toBeNull();
  if (!Owned) return;
  const project = { id, scripts: [setup] };
  expect(
    Owned.resolveOwnedEnrollment(
      DEFAULT_SERVER_SETTINGS,
      project,
      "node scripts/dev-runner.ts dev",
    ),
  ).toEqual({ setupCommand: setup.command, devCommand: "node scripts/dev-runner.ts dev" });
  expect(
    Owned.resolveOwnedEnrollment(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectScriptOverrides: { [id]: [{ ...setup, command: "custom" }] },
      },
      project,
      "pnpm dev",
    ),
  ).toBeUndefined();
  expect(
    Owned.resolveOwnedEnrollment(DEFAULT_SERVER_SETTINGS, project, "custom dev"),
  ).toBeUndefined();
  expect(
    Owned.resolveOwnedEnrollment(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true },
      project,
      "pnpm dev",
    ),
  ).toBeUndefined();
});
