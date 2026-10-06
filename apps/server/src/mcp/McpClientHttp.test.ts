import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ProviderInstanceId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as McpClientCredentials from "./McpClientCredentials.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

it.effect(
  "authenticates an outside client over HTTP, launches at its ceiling, and refuses revoked tokens",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:client-target");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("claude"),
        model: "claude-opus",
      };
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(DeviceService.DeviceService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({ id, defaultModelSelection: modelSelection } as unknown as Project)
                : Option.none(),
            ),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            launched.push(input);
            return Effect.succeed({
              threadId: input.threadId,
              projection: {
                thread: {
                  id: input.threadId,
                  projectId: input.projectId,
                  modelSelection: input.modelSelection,
                },
                runs: [],
              },
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult);
          },
        }),
        ServerSettings.layerTest({}),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("client-http-test")),
        }),
        PreviewAutomationBroker.layer,
      );
      yield* HttpRouter.serve(McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(dependencies), Layer.build);

      const store = yield* McpClientCredentials.McpClientCredentials;
      const issued = yield* store.issue({
        label: "outside",
        runtimeModeCeiling: "auto-accept-edits",
      });
      const http = yield* HttpClient.HttpClient;
      let sessionId: string | undefined;
      const request = (token: string, id: number, method: string, params: unknown) =>
        http.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "mcp-protocol-version": "2025-06-18",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: HttpBody.text(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }),
            "application/json",
          ),
        });
      const init = yield* request(issued.token, 1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(init.status).toBe(200);
      sessionId = init.headers["mcp-session-id"];
      const list = yield* request(issued.token, 2, "tools/list", {});
      const toolsText = yield* list.text;
      expect(toolsText).toContain('"t3_thread_launch"');
      const launch = yield* request(issued.token, 3, "tools/call", {
        name: "t3_thread_launch",
        arguments: { title: "Test", projectId },
      });
      expect(launch.status).toBe(200);
      const text = yield* launch.text;
      expect(text).toContain('"isError":false');
      expect(launched).toHaveLength(1);
      expect(launched[0]?.runtimeMode).toBe("auto-accept-edits");
      const escalation = yield* request(issued.token, 4, "tools/call", {
        name: "t3_thread_launch",
        arguments: { title: "Forbidden", projectId, runtimeMode: "full-access" },
      });
      expect(yield* escalation.text).toContain("runtime_mode_escalation_denied");
      expect(launched).toHaveLength(1);
      const preview = yield* request(issued.token, 5, "tools/call", {
        name: "preview_status",
        arguments: {},
      });
      expect(yield* preview.text).toContain('"isError":true');
      expect((yield* request("unknown", 6, "tools/list", {})).status).toBe(401);
      yield* store.revoke(issued.credential.id);
      expect((yield* request(issued.token, 7, "tools/list", {})).status).toBe(401);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          McpClientCredentials.layer.pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-http-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
          NodeHttpServer.layerTest,
        ),
      ),
    ),
);
