import { defineAttachmentSource } from "@getpaseo/plugin";
import {
  useAgent,
  useRpc,
  useTranslation,
  type PluginAgentPanelProps,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon, Markdown, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import {
  isAntigravityProvider,
  listAgentArtifactsRpc,
  readAgentArtifactRpc,
  searchArtifactsAttachmentRpc,
  type AgentArtifactInfo,
  type ArtifactKind,
} from "../shared/contracts";
import { relative } from "./format";
import { errorMessage, messages } from "./messages";
import { font, mono, radius, space, tabular, tint, type Colors } from "./theme";
import { Badge, Button, Muted } from "./ui";

export const ARTIFACTS_PANEL_ID = "artifacts";

export const artifactsAttachmentSource = defineAttachmentSource({
  id: "antigravity-artifacts",
  title: messages.message("artifacts.attachTitle"),
  icon: "FileStack",
  pickerTitle: messages.message("artifacts.attachPickerTitle"),
  searchPlaceholder: messages.message("artifacts.attachSearchPlaceholder"),
  search: searchArtifactsAttachmentRpc,
});

type OwnerFilter = "all" | "main" | "subagent";

const artifactErrors = {
  ARTIFACT_INVALID_PATH: "artifacts.err.invalidPath",
  ARTIFACT_NO_CONVERSATION: "artifacts.err.noConversation",
  ARTIFACT_NOT_OWNED: "artifacts.err.notOwned",
  ARTIFACT_UNREADABLE: "artifacts.err.unreadable",
} as const;

function translateArtifactError(error: unknown, t: (key: typeof artifactErrors[keyof typeof artifactErrors]) => string) {
  const message = errorMessage(error);
  const code = /\[(ARTIFACT_[A-Z_]+)\]/.exec(message)?.[1];
  return code && Object.hasOwn(artifactErrors, code) ? t(artifactErrors[code as keyof typeof artifactErrors]) : message;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function kindIcon(kind: ArtifactKind): string {
  switch (kind) {
    case "markdown":
      return "FileText";
    case "image":
      return "Image";
    case "code":
      return "FileCode";
    case "text":
      return "FileSpreadsheet";
    default:
      return "File";
  }
}

function FilterChip({
  colors,
  label,
  active,
  onPress,
}: {
  colors: Colors;
  label: string;
  active: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        paddingHorizontal: space.sm,
        height: 24,
        borderRadius: radius.pill,
        justifyContent: "center",
        backgroundColor: active ? tint(colors.accent, 0.16) : tint(colors.foreground, 0.06),
      }}
    >
      <Text style={{ ...font.caption, fontWeight: "500", color: active ? colors.accent : colors.foregroundMuted }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Empty({ colors, icon, text }: { colors: Colors; icon: string; text: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, backgroundColor: colors.surface0, padding: space.xl }}>
      <Icon name={icon} size={22} color={colors.foregroundMuted} />
      {text ? <Text style={{ ...font.small, color: colors.foregroundMuted, textAlign: "center" }}>{text}</Text> : null}
    </View>
  );
}

function ArtifactViewer({
  colors,
  agentId,
  item,
  compact,
  onInsert,
}: {
  colors: Colors;
  agentId: string;
  item: AgentArtifactInfo;
  compact: boolean;
  onInsert(text: string): boolean;
}) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const read = useRpc(readAgentArtifactRpc);
  // Keyed on file updatedAt + size so in-place edits immediately invalidate cached content.
  const query = useQuery({
    queryKey: ["antigravity-accounts", "artifact-read", agentId, item.conversationId, item.path, item.updatedAt, item.size],
    queryFn: () => read({ agentId, conversationId: item.conversationId, path: item.path }),
    staleTime: 10_000,
  });
  const data = query.data;
  const contentReady = !query.isError && !query.isFetching && data?.content !== null && data?.content !== undefined;
  const pad = compact ? space.lg : space.xxl;
  const updated = relative(item.updatedAt, Date.now(), locale);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: pad, gap: space.lg }}>
      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Icon name={kindIcon(item.kind)} size={18} color={colors.accent} />
          <Text style={{ ...font.heading, color: colors.foreground, flexShrink: 1 }}>{item.name}</Text>
          <Badge
            colors={colors}
            label={item.owner === "main" ? t("artifacts.ownerMain") : (item.ownerLabel ?? t("artifacts.ownerSubagent"))}
            tone={item.owner === "main" ? "accent" : "neutral"}
          />
        </View>
        <Text selectable style={{ ...font.caption, fontFamily: mono, color: colors.foregroundMuted }}>
          {item.displayPath}
        </Text>
        <Text style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
          {[formatBytes(item.size), updated].filter(Boolean).join(" · ")}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2, marginTop: space.xs }}>
          <Button
            colors={colors}
            size="sm"
            variant="secondary"
            icon="Copy"
            label={t("artifacts.copyPath")}
            onPress={() => {
              void copyText(item.displayPath).then(() => toast.show(t("artifacts.pathCopied"), { durationMs: 2500 }));
            }}
          />
          {data?.content !== null && data?.content !== undefined ? (
            <>
              <Button
                colors={colors}
                size="sm"
                variant="secondary"
                icon="ClipboardCopy"
                disabled={!contentReady}
                label={t("artifacts.copyContent")}
                onPress={() => {
                  if (!contentReady || data.content === null) return;
                  void copyText(data.content).then(() =>
                    toast.show(t("artifacts.contentCopied"), { durationMs: 2500 }),
                  );
                }}
              />
              <Button
                colors={colors}
                size="sm"
                variant="secondary"
                icon="CornerDownLeft"
                disabled={!contentReady}
                label={t("artifacts.insertComposer")}
                onPress={() => {
                  if (!contentReady || data.content === null) return;
                  const ok = onInsert(data.content);
                  toast.show(ok ? t("artifacts.insertedComposer") : t("subagents.composerUnavailable"), {
                    durationMs: 2500,
                  });
                }}
              />
            </>
          ) : null}
        </View>
      </View>

      {query.isLoading ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.lg }}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Muted colors={colors}>{t("subagents.artifactLoading")}</Muted>
        </View>
      ) : query.error ? (
        <Text style={{ ...font.small, color: colors.statusDanger }}>{translateArtifactError(query.error, t)}</Text>
      ) : !data ? null : data.kind === "image" ? (
        data.tooLarge || !data.dataUri ? (
          <View
            style={{
              padding: space.lg,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
            }}
          >
            <Muted colors={colors}>{t("artifacts.imageTooLarge")}</Muted>
          </View>
        ) : (
          <View
            style={{
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
              padding: space.md,
              alignItems: "center",
            }}
          >
            <Image
              source={{ uri: data.dataUri }}
              resizeMode="contain"
              accessibilityLabel={item.name}
              style={{ width: "100%", height: compact ? 280 : 440, borderRadius: radius.sm }}
            />
          </View>
        )
      ) : data.kind === "binary" ? (
        <View
          style={{
            padding: space.lg,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <Muted colors={colors}>{t("artifacts.binaryNotice")}</Muted>
        </View>
      ) : (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.lg,
            backgroundColor: colors.surface1,
            padding: space.lg,
            gap: space.sm,
          }}
        >
          {data.truncated ? (
            <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("subagents.artifactTruncated")}</Text>
          ) : null}
          {data.kind === "markdown" ? (
            <Markdown>{data.content ?? ""}</Markdown>
          ) : (
            <Text selectable style={{ fontSize: 12, lineHeight: 18, fontFamily: mono, color: colors.foreground }}>
              {data.content ?? ""}
            </Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}

export function createArtifactsView(client: PluginClientContext) {
  function insertIntoComposer(agentId: string, text: string): boolean {
    const composer = client.composers({ agentId })[0];
    if (!composer) return false;
    composer.insertText(text);
    void composer.focus().catch(() => undefined);
    return true;
  }

  function ArtifactsPanel({ theme, layout, params, revision }: PluginAgentPanelProps) {
    const { colors } = theme;
    const { t, locale } = useTranslation(messages);
    const agentId = params.agentId;
    const agent = useAgent(agentId, (snapshot) => ({ provider: snapshot.provider }));
    const antigravity = isAntigravityProvider(agent?.provider);
    const listRpc = useRpc(listAgentArtifactsRpc);
    const query = useQuery({
      queryKey: ["antigravity-accounts", "artifacts", agentId],
      queryFn: () => listRpc({ agentId }),
      enabled: antigravity,
      staleTime: 2000,
      refetchInterval: 8000,
    });
    const items = query.data?.items ?? [];
    const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("all");
    const [search, setSearch] = useState("");
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [panelWidth, setPanelWidth] = useState(0);

    useEffect(() => {
      setOwnerFilter("all");
      setSearch("");
      setSelectedKey(null);
    }, [agentId, revision]);

    const hasMain = items.some((entry) => entry.owner === "main");
    const hasSubagent = items.some((entry) => entry.owner === "subagent");
    const narrow = layout.compact || (panelWidth > 0 && panelWidth < 640);

    const filtered = useMemo(() => {
      const q = search.trim().toLowerCase();
      return items.filter((entry) => {
        if (ownerFilter !== "all" && entry.owner !== ownerFilter) return false;
        if (!q) return true;
        return (
          entry.name.toLowerCase().includes(q) ||
          entry.path.toLowerCase().includes(q) ||
          (entry.ownerLabel ?? "").toLowerCase().includes(q)
        );
      });
    }, [items, ownerFilter, search]);

    const keyOf = (entry: AgentArtifactInfo) => `${entry.conversationId}:${entry.path}`;
    // Only allow selecting from the current filtered list so empty searches never show hidden items.
    const current =
      filtered.find((entry) => keyOf(entry) === selectedKey) ?? (narrow ? undefined : filtered[0]);

    if (!antigravity) return <Empty colors={colors} icon="FileStack" text={t("subagents.notAntigravity")} />;
    if (query.isLoading) return <Empty colors={colors} icon="LoaderCircle" text="" />;
    if (query.isError) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, backgroundColor: colors.surface0, padding: space.xl }}>
          <Icon name="CircleAlert" size={22} color={colors.statusDanger} />
          <Text style={{ ...font.small, color: colors.statusDanger, textAlign: "center" }}>{translateArtifactError(query.error, t)}</Text>
          <Button colors={colors} size="sm" variant="secondary" label={t("retry")} onPress={() => void query.refetch()} />
        </View>
      );
    }
    if (!items.length) return <Empty colors={colors} icon="FileStack" text={t("artifacts.empty")} />;

    const header = (
      <View style={{ gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xs }}>
          <Text style={{ ...font.heading, color: colors.foreground, flex: 1 }}>{t("artifacts.title")}</Text>
          <Text style={{ ...font.small, ...tabular, color: colors.foregroundMuted }}>{items.length}</Text>
        </View>
        {hasMain && hasSubagent ? (
          <View style={{ flexDirection: "row", gap: space.xs, flexWrap: "wrap" }}>
            <FilterChip colors={colors} label={t("subagents.filter.all")} active={ownerFilter === "all"} onPress={() => setOwnerFilter("all")} />
            <FilterChip colors={colors} label={t("artifacts.ownerMain")} active={ownerFilter === "main"} onPress={() => setOwnerFilter("main")} />
            <FilterChip colors={colors} label={t("artifacts.ownerSubagent")} active={ownerFilter === "subagent"} onPress={() => setOwnerFilter("subagent")} />
          </View>
        ) : null}
        {items.length > 3 ? (
          <TextInput
            accessibilityLabel={t("artifacts.searchPlaceholder")}
            value={search}
            onChangeText={setSearch}
            placeholder={t("artifacts.searchPlaceholder")}
            placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
            style={{
              ...font.caption,
              color: colors.foreground,
              backgroundColor: colors.surface1,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.md,
              paddingHorizontal: space.sm + 2,
              paddingVertical: space.xs + 2,
            }}
          />
        ) : null}
      </View>
    );

    const rows = (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: space.lg, gap: 2 }}>
        {filtered.length === 0 ? (
          <View style={{ padding: space.lg, alignItems: "center" }}>
            <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("subagents.noMatches")}</Text>
          </View>
        ) : (
          filtered.map((entry) => {
            const key = keyOf(entry);
            const active = !narrow && current ? keyOf(current) === key : false;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setSelectedKey(key)}
                style={(pressState) => ({
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: space.sm,
                  paddingVertical: space.sm,
                  paddingHorizontal: space.sm,
                  borderRadius: radius.md,
                  backgroundColor: active
                    ? tint(colors.accent, 0.1)
                    : (pressState as { hovered?: boolean }).hovered || pressState.pressed
                      ? tint(colors.foreground, 0.05)
                      : "transparent",
                })}
              >
                <View style={{ paddingTop: 2 }}>
                  <Icon name={kindIcon(entry.kind)} size={14} color={active ? colors.accent : colors.foregroundMuted} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
                    {entry.name}
                  </Text>
                  <Text numberOfLines={1} style={{ ...font.caption, fontFamily: mono, color: colors.foregroundMuted }}>
                    {entry.path}
                  </Text>
                  <Text numberOfLines={1} style={{ ...font.caption, ...tabular, color: colors.foregroundMuted }}>
                    {[
                      entry.owner === "subagent" ? entry.ownerLabel ?? t("artifacts.ownerSubagent") : null,
                      formatBytes(entry.size),
                      relative(entry.updatedAt, Date.now(), locale),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    );

    if (narrow) {
      if (current) {
        return (
          <View
            style={{ flex: 1, backgroundColor: colors.surface0 }}
            onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => setSelectedKey(null)}
              style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, paddingVertical: space.sm }}
            >
              <Icon name="ChevronLeft" size={16} color={colors.accent} />
              <Text style={{ ...font.small, color: colors.accent }}>{t("subagents.back")}</Text>
            </Pressable>
            <ArtifactViewer
              key={keyOf(current)}
              colors={colors}
              agentId={agentId}
              item={current}
              compact
              onInsert={(text) => insertIntoComposer(agentId, text)}
            />
          </View>
        );
      }
      return (
        <View
          style={{ flex: 1, backgroundColor: colors.surface0 }}
          onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
        >
          {header}
          {rows}
        </View>
      );
    }

    const listWidth = panelWidth > 0 ? Math.min(280, Math.max(210, Math.round(panelWidth * 0.34))) : 260;

    return (
      <View
        style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface0 }}
        onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}
      >
        <View style={{ width: listWidth, borderRightWidth: 1, borderRightColor: colors.border }}>
          {header}
          {rows}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {current ? (
            <ArtifactViewer
              key={keyOf(current)}
              colors={colors}
              agentId={agentId}
              item={current}
              compact={false}
              onInsert={(text) => insertIntoComposer(agentId, text)}
            />
          ) : (
            <Empty
              colors={colors}
              icon={filtered.length === 0 ? "SearchX" : "MousePointerClick"}
              text={filtered.length === 0 ? t("subagents.noMatches") : t("artifacts.pick")}
            />
          )}
        </View>
      </View>
    );
  }

  return { ArtifactsPanel };
}
