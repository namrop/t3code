import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";
import { resolveProjectScripts, setupProjectScript } from "@t3tools/shared/projectScripts";
import type { CreateWorktreeOptions } from "./GitVcsDriver.ts";

export function resolveOwnedEnrollment(
  settings: ServerSettings,
  project: { readonly id: ProjectId; readonly scripts: readonly ProjectScript[] },
  devCommand: string,
): CreateWorktreeOptions["ownedEnrollment"] {
  const setup = setupProjectScript(resolveProjectScripts(settings, project));
  if (
    setup?.command !== "node scripts/setup-worktree.ts" ||
    !["pnpm dev", "node scripts/dev-runner.ts dev"].includes(devCommand)
  )
    return undefined;
  return { setupCommand: setup.command, devCommand };
}
