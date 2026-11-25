import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { getPricingRpc, setPricingRpc, type PricingModelRow } from "../shared/contracts";
import type { ModelRates } from "../shared/pricing";
import { errorMessage, messages } from "./messages";
import { font, mono, radius, space, tabular, tint, type Colors } from "./theme";
import { Badge, Button, Callout, Divider, Muted } from "./ui";

export const PRICING_QUERY_KEY = ["antigravity-accounts", "pricing"] as const;

export function usePricing() {
  const read = useRpc(getPricingRpc);
  return useQuery({
    queryKey: PRICING_QUERY_KEY,
    queryFn: () => read({}),
    staleTime: 60_000,
  });
}

function fmtRate(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return String(value);
}

function parseRate(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) return null;
  return parsed;
}

function RateInput({
  colors,
  label,
  value,
  editable,
  onChangeText,
}: {
  colors: Colors;
  label: string;
  value: string;
  editable: boolean;
  onChangeText(text: string): void;
}) {
  return (
    <View style={{ flex: 1, minWidth: 86, gap: 4 }}>
      <Text numberOfLines={1} style={{ ...font.caption, color: colors.foregroundMuted }}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.surface0,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.sm,
          paddingHorizontal: space.sm,
        }}
      >
        <Text style={{ ...font.small, color: colors.foregroundMuted, marginRight: 2 }}>$</Text>
        <TextInput
          accessibilityLabel={label}
          keyboardType="decimal-pad"
          value={value}
          editable={editable}
          onChangeText={onChangeText}
          placeholder="0"
          placeholderTextColor={tint(colors.foregroundMuted, 0.5)}
          style={{
            ...font.small,
            ...tabular,
            flex: 1,
            color: colors.foreground,
            paddingVertical: 6,
          }}
        />
      </View>
    </View>
  );
}

function PricingRowEditor({
  colors,
  row,
  initialExpanded,
  onSave,
  onReset,
}: {
  colors: Colors;
  row: PricingModelRow;
  initialExpanded: boolean;
  onSave(rates: ModelRates): Promise<void>;
  onReset(): Promise<void>;
}) {
  const { t } = useTranslation(messages);
  const [expanded, setExpanded] = useState(initialExpanded);
  const base = row.effective;
  const [inputStr, setInputStr] = useState(fmtRate(base?.input));
  const [cachedStr, setCachedStr] = useState(fmtRate(base?.cached));
  const [outputStr, setOutputStr] = useState(fmtRate(base?.output));
  const [hasLongTier, setHasLongTier] = useState(Boolean(base?.longContextThreshold));
  const [longInputStr, setLongInputStr] = useState(fmtRate(base?.longInput));
  const [longCachedStr, setLongCachedStr] = useState(fmtRate(base?.longCached));
  const [longOutputStr, setLongOutputStr] = useState(fmtRate(base?.longOutput));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const next = row.effective;
    setInputStr(fmtRate(next?.input));
    setCachedStr(fmtRate(next?.cached));
    setOutputStr(fmtRate(next?.output));
    setHasLongTier(Boolean(next?.longContextThreshold));
    setLongInputStr(fmtRate(next?.longInput));
    setLongCachedStr(fmtRate(next?.longCached));
    setLongOutputStr(fmtRate(next?.longOutput));
    setError("");
  }, [row.effective]);

  const summaryText = base
    ? `$${base.input} / $${base.cached} / $${base.output}`
    : t("pricing.unpriced");

  async function submit() {
    const input = parseRate(inputStr);
    const cached = parseRate(cachedStr);
    const output = parseRate(outputStr);
    if (input === null || cached === null || output === null) {
      setError(t("pricing.invalidRate"));
      return;
    }
    const next: ModelRates = { input, cached, output };
    if (hasLongTier) {
      const li = parseRate(longInputStr);
      const lc = parseRate(longCachedStr);
      const lo = parseRate(longOutputStr);
      if (li === null || lc === null || lo === null) {
        setError(t("pricing.invalidRate"));
        return;
      }
      next.longContextThreshold = row.official?.longContextThreshold ?? 200_000;
      next.longInput = li;
      next.longCached = lc;
      next.longOutput = lo;
    }
    setBusy(true);
    setError("");
    try {
      await onSave(next);
      setExpanded(false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError("");
    try {
      await onReset();
      setExpanded(false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: expanded ? tint(colors.accent, 0.45) : colors.border,
        borderRadius: radius.md,
        backgroundColor: colors.surface1,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => {
          setError("");
          setExpanded(!expanded);
        }}
        style={(state) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: space.sm + 2,
          backgroundColor: (state as { hovered?: boolean }).hovered ? tint(colors.foreground, 0.04) : "transparent",
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" }}>
            <Text numberOfLines={1} style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>
              {row.label}
            </Text>
            {row.custom ? <Badge colors={colors} label={t("pricing.badgeCustom")} tone="accent" /> : null}
            {row.seenLocally && !row.custom ? <Badge colors={colors} label={t("pricing.badgeUsed")} /> : null}
          </View>
          <Text numberOfLines={1} style={{ ...font.caption, fontFamily: mono, color: colors.foregroundMuted }}>
            {row.key}
          </Text>
        </View>
        <Text numberOfLines={1} style={{ ...font.caption, ...tabular, color: base ? colors.foreground : colors.statusWarning }}>
          {summaryText}
        </Text>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
      </Pressable>

      {expanded ? (
        <View style={{ padding: space.md, paddingTop: space.xs, gap: space.md, borderTopWidth: 1, borderTopColor: colors.border }}>
          {row.official ? (
            <Muted colors={colors} small>
              {t("pricing.officialRef", {
                input: row.official.input,
                cached: row.official.cached,
                output: row.official.output,
              })}
              {row.note ? ` · ${row.note}` : ""}
            </Muted>
          ) : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <RateInput colors={colors} label={t("pricing.input")} value={inputStr} editable={!busy} onChangeText={setInputStr} />
            <RateInput colors={colors} label={t("pricing.cached")} value={cachedStr} editable={!busy} onChangeText={setCachedStr} />
            <RateInput colors={colors} label={t("pricing.output")} value={outputStr} editable={!busy} onChangeText={setOutputStr} />
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              const next = !hasLongTier;
              setHasLongTier(next);
              if (next && !longInputStr && !longOutputStr) {
                const i = parseRate(inputStr) ?? 0;
                const c = parseRate(cachedStr) ?? 0;
                const o = parseRate(outputStr) ?? 0;
                setLongInputStr(String(Number((i * 2).toFixed(4))));
                setLongCachedStr(String(Number((c * 2).toFixed(4))));
                setLongOutputStr(String(Number((o * 1.5).toFixed(4))));
              }
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "flex-start" }}
          >
            <Icon name={hasLongTier ? "CheckSquare" : "Square"} size={14} color={hasLongTier ? colors.accent : colors.foregroundMuted} />
            <Text style={{ ...font.caption, color: colors.foregroundMuted }}>{t("pricing.longContextToggle")}</Text>
          </Pressable>

          {hasLongTier ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              <RateInput colors={colors} label={t("pricing.longInput")} value={longInputStr} editable={!busy} onChangeText={setLongInputStr} />
              <RateInput colors={colors} label={t("pricing.longCached")} value={longCachedStr} editable={!busy} onChangeText={setLongCachedStr} />
              <RateInput colors={colors} label={t("pricing.longOutput")} value={longOutputStr} editable={!busy} onChangeText={setLongOutputStr} />
            </View>
          ) : null}

          {error ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={error} /> : null}

          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
            {row.custom ? (
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                icon="RotateCcw"
                label={row.official ? t("pricing.resetDefault") : t("pricing.removeCustom")}
                disabled={busy}
                onPress={() => void reset()}
              />
            ) : null}
            <Button
              colors={colors}
              size="sm"
              variant="primary"
              icon="Check"
              label={t("dialog.save")}
              loading={busy}
              onPress={() => void submit()}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Modal for inspecting official Google/3P API prices and customizing rates per model. */
export function PricingDialog({
  colors,
  focusKey,
  onClose,
}: {
  colors: Colors;
  focusKey?: string | null;
  onClose(): void;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const cache = useQueryClient();
  const query = usePricing();
  const savePricing = useRpc(setPricingRpc);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newInput, setNewInput] = useState("");
  const [newCached, setNewCached] = useState("");
  const [newOutput, setNewOutput] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const [resettingAll, setResettingAll] = useState(false);

  const models = query.data?.models ?? [];
  const hasAnyCustom = models.some((row) => row.custom !== null);

  async function applyChange(payload: { key?: string; rates?: ModelRates | null; resetAll?: boolean }) {
    const next = await savePricing(payload);
    cache.setQueryData(PRICING_QUERY_KEY, next);
    await cache.invalidateQueries({ queryKey: ["antigravity-accounts", "stats"] });
  }

  async function submitNew() {
    const key = newKey.trim().toLowerCase();
    const input = parseRate(newInput);
    const cached = parseRate(newCached);
    const output = parseRate(newOutput);
    if (!key) {
      setAddError(t("pricing.invalidKey"));
      return;
    }
    if (input === null || cached === null || output === null) {
      setAddError(t("pricing.invalidRate"));
      return;
    }
    setAddBusy(true);
    setAddError("");
    try {
      await applyChange({ key, rates: { input, cached, output } });
      setNewKey("");
      setNewInput("");
      setNewCached("");
      setNewOutput("");
      setAdding(false);
      toast.show(t("pricing.saved"), { variant: "success" });
    } catch (reason) {
      setAddError(errorMessage(reason));
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <Modal open title={t("pricing.title")} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content>
        <Muted colors={colors}>{t("pricing.subtitle")}</Muted>

        {query.isLoading ? (
          <Muted colors={colors}>{t("loading")}</Muted>
        ) : query.error ? (
          <Callout colors={colors} tone="danger" icon="CircleAlert" title={errorMessage(query.error)} />
        ) : (
          <View style={{ gap: space.sm }}>
            {models.map((row) => (
              <PricingRowEditor
                key={row.key}
                colors={colors}
                row={row}
                initialExpanded={focusKey === row.key}
                onSave={async (rates) => {
                  await applyChange({ key: row.key, rates });
                  toast.show(t("pricing.saved"), { variant: "success" });
                }}
                onReset={async () => {
                  await applyChange({ key: row.key, rates: null });
                  toast.show(t("pricing.restored"), { variant: "success" });
                }}
              />
            ))}
          </View>
        )}

        <Divider colors={colors} />

        {adding ? (
          <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border }}>
            <Text style={{ ...font.small, fontWeight: "600", color: colors.foreground }}>{t("pricing.addModel")}</Text>
            <TextInput
              accessibilityLabel={t("pricing.modelKeyPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              value={newKey}
              editable={!addBusy}
              onChangeText={setNewKey}
              placeholder={t("pricing.modelKeyPlaceholder")}
              placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
              style={{
                ...font.small,
                fontFamily: mono,
                color: colors.foreground,
                backgroundColor: colors.surface0,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.sm,
                paddingHorizontal: space.sm,
                paddingVertical: 6,
              }}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              <RateInput colors={colors} label={t("pricing.input")} value={newInput} editable={!addBusy} onChangeText={setNewInput} />
              <RateInput colors={colors} label={t("pricing.cached")} value={newCached} editable={!addBusy} onChangeText={setNewCached} />
              <RateInput colors={colors} label={t("pricing.output")} value={newOutput} editable={!addBusy} onChangeText={setNewOutput} />
            </View>
            {addError ? <Callout colors={colors} tone="danger" icon="CircleAlert" title={addError} /> : null}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                label={t("dialog.cancel")}
                disabled={addBusy}
                onPress={() => {
                  setAddError("");
                  setAdding(false);
                }}
              />
              <Button colors={colors} size="sm" variant="primary" label={t("dialog.save")} loading={addBusy} onPress={() => void submitNew()} />
            </View>
          </View>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <Button
              colors={colors}
              size="sm"
              variant="secondary"
              icon="Plus"
              label={t("pricing.addModel")}
              onPress={() => {
                setAddError("");
                setAdding(true);
              }}
            />
            {hasAnyCustom ? (
              <Button
                colors={colors}
                size="sm"
                variant="ghost"
                icon="RotateCcw"
                label={t("pricing.resetAll")}
                loading={resettingAll}
                onPress={() => {
                  setResettingAll(true);
                  void applyChange({ resetAll: true })
                    .then(() => toast.show(t("pricing.restoredAll"), { variant: "success" }))
                    .catch((reason: unknown) => toast.error(errorMessage(reason)))
                    .finally(() => setResettingAll(false));
                }}
              />
            ) : null}
            <View style={{ flex: 1 }} />
            <Button colors={colors} size="sm" variant="ghost" label={t("dialog.close")} onPress={onClose} />
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}
