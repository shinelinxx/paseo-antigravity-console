import {
  useTranslation,
  type PluginClientContext,
  type PluginSidebarItemProps,
  type PluginSurfaceProps,
  type PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { AccountsScreen } from "./client/AccountsScreen";
import { observeAgents } from "./client/agents";
import { ARTIFACTS_PANEL_ID, artifactsAttachmentSource, createArtifactsView } from "./client/artifacts";
import { ComposerAccount } from "./client/composer";
import { antigravityLogoSvg } from "./client/logo";
import { errorMessage, messages } from "./client/messages";
import { QuotaSidebarItem } from "./client/sidebar";
import { SUBAGENT_PANEL_ID, createSubagentViews } from "./client/subagents";
import { AskQuestionRow } from "./client/questions";
import { FallbackNote } from "./client/timeline";
import { CompactToolRow, LegacyUpdateStepsRow, UpdateStepsRow } from "./client/tools";
import { registerSubagentTransforms } from "./client/transform";
import { AccountsClientContext } from "./client/useAccounts";
import {
  ASK_QUESTION_TIMELINE_KIND,
  COMPACT_TOOL_TIMELINE_KIND,
  FALLBACK_TIMELINE_KIND,
  SUBAGENT_LIST_TIMELINE_KIND,
  SUBAGENT_TIMELINE_KIND,
  UPDATE_STEPS_TIMELINE_KIND,
  askQuestionCardSchema,
  compactToolCardSchema,
  fallbackEventSchema,
  refreshAccountsRpc,
  subagentCardSchema,
  subagentCheckSchema,
  updateStepsCardSchema,
} from "./shared/contracts";

const settingsLogo = { svg: antigravityLogoSvg("settings") };
const commandLogo = { svg: antigravityLogoSvg("command") };

export default function contribute(client: PluginClientContext) {
  const subagents = createSubagentViews(client);
  const artifacts = createArtifactsView(client);
  const observation = observeAgents(client, subagents.open);
  const title = messages.message("title");

  function Screen(props: PluginSurfaceProps) {
    observation.useNotifications();
    return (
      <AccountsClientContext.Provider value={client}>
        <AccountsScreen {...props} observation={observation} />
      </AccountsClientContext.Provider>
    );
  }
  function Sidebar(props: PluginSidebarItemProps) {
    observation.useNotifications();
    return (
      <AccountsClientContext.Provider value={client}>
        <QuotaSidebarItem {...props} />
      </AccountsClientContext.Provider>
    );
  }
  function Composer() {
    observation.useNotifications();
    return (
      <AccountsClientContext.Provider value={client}>
        <ComposerAccount />
      </AccountsClientContext.Provider>
    );
  }
  function SubagentsWorkspaceBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
    const { t } = useTranslation(messages);
    const byWorkspace = useSyncExternalStore(observation.subscribe, observation.workspaceRunningSubagents);
    const running = byWorkspace.get(workspaceId) ?? 0;
    if (!running) return null;
    return <WorkspaceRowBadge icon="Bot" tone="info" label={t("subagents.workspaceBadge", { count: running })} />;
  }

  const cleanup = [
    client.addScreen({ id: "accounts", title, Component: Screen }),
    client.addSettingsScreen({ id: "accounts", title, icon: settingsLogo, Component: Screen }),
    client.addSidebarFooterItem({ id: "accounts", title, Component: Sidebar }),
    client.addWorkspaceRowBadgeItem({
      id: "running-subagents",
      title: messages.message("subagents.title"),
      icon: "Bot",
      Component: SubagentsWorkspaceBadge,
    }),
    client.addCommandCenterItem({
      id: "accounts",
      title,
      icon: commandLogo,
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: "accounts" }),
    }),
    client.addCommandCenterItem({
      id: "refresh-quotas",
      title: messages.message("commandRefresh"),
      icon: "RefreshCw",
      context: "global",
      onSelect: async ({ rpc }) => {
        try {
          await rpc(refreshAccountsRpc, {});
          observation.notify(client.i18n.t(messages, "commandRefreshed"));
        } catch (error) {
          observation.notify(errorMessage(error));
        }
      },
    }),
    client.addCommandCenterItem({
      id: "open-artifacts",
      title: messages.message("artifacts.commandOpen"),
      icon: "FileStack",
      context: "agent",
      onSelect: ({ openPanel }) => openPanel(ARTIFACTS_PANEL_ID),
    }),
    client.addComposerItem({ id: "account", Component: Composer }),
    client.addAttachmentSource(artifactsAttachmentSource),
    client.addTimelineRenderer({ kind: FALLBACK_TIMELINE_KIND, version: 1, schema: fallbackEventSchema, Component: FallbackNote }),
    client.addTimelineRenderer({ kind: SUBAGENT_TIMELINE_KIND, version: 1, schema: subagentCardSchema, Component: subagents.SubagentCardRow }),
    client.addTimelineRenderer({ kind: SUBAGENT_LIST_TIMELINE_KIND, version: 1, schema: subagentCheckSchema, Component: subagents.SubagentCheckRow }),
    client.addTimelineRenderer({ kind: ASK_QUESTION_TIMELINE_KIND, version: 1, schema: askQuestionCardSchema, Component: AskQuestionRow }),
    client.addTimelineRenderer({ kind: UPDATE_STEPS_TIMELINE_KIND, version: 1, schema: updateStepsCardSchema, Component: LegacyUpdateStepsRow }),
    client.addTimelineRenderer({ kind: UPDATE_STEPS_TIMELINE_KIND, version: 2, schema: updateStepsCardSchema, Component: UpdateStepsRow }),
    client.addTimelineRenderer({ kind: COMPACT_TOOL_TIMELINE_KIND, version: 1, schema: compactToolCardSchema, Component: CompactToolRow }),
    registerSubagentTransforms(client, { onStepsToolSeen: observation.syncTasksSoon }),
    client.addAgentPanel({
      id: SUBAGENT_PANEL_ID,
      title: messages.message("subagents.title"),
      icon: "Bot",
      Component: subagents.SubagentsPanel,
    }),
    client.addAgentPanel({
      id: ARTIFACTS_PANEL_ID,
      title: messages.message("artifacts.title"),
      icon: "FileStack",
      Component: artifacts.ArtifactsPanel,
    }),
  ];
  return () => {
    observation.stop();
    cleanup.forEach((remove) => remove());
  };
}
