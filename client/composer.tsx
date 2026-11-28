import { useComposer, useTranslation, type PluginComposer } from "@getpaseo/plugin/client";
import { Select } from "@getpaseo/plugin/client/ui";
import {
  ACCOUNT_METADATA_KEY,
  AUTO_ACCOUNT_ID,
  SYSTEM_ACCOUNT_ID,
  isAntigravityProvider,
  isAutoAccountId,
} from "../shared/contracts";
import { displayLabel, shortPlan } from "./labels";
import { messages } from "./messages";
import { accountSupportsModel, activeCooldownForModel, compactQuotaSummary, pickBestLocal } from "./quota";
import { useAccounts } from "./useAccounts";

function DraftAccount({ composer }: { composer: PluginComposer }) {
  const { data } = useAccounts();
  const { t, locale } = useTranslation(messages);
  if (!data) return null;
  const loadBalancing = data.routing.mode !== "default";
  const rawSelected = composer.agent.metadata[ACCOUNT_METADATA_KEY];
  const selected =
    typeof rawSelected === "string" ? (isAutoAccountId(rawSelected) ? AUTO_ACCOUNT_ID : rawSelected) : null;
  const hasExplicitAccount =
    selected !== null && selected !== AUTO_ACCOUNT_ID && data.accounts.some((account) => account.id === selected);
  const configuredDefault =
    data.defaultAccountId !== AUTO_ACCOUNT_ID
      ? data.accounts.find((account) => account.id === data.defaultAccountId)
      : undefined;
  const effectiveDefaultId =
    data.defaultAccountId === AUTO_ACCOUNT_ID
      ? AUTO_ACCOUNT_ID
      : configuredDefault && (!configuredDefault.usable || configuredDefault.status === "signed-out")
        ? (data.accounts.find((account) => account.id === SYSTEM_ACCOUNT_ID && account.usable)?.id ??
          data.defaultAccountId)
        : data.defaultAccountId;
  const activeValue =
    selected === AUTO_ACCOUNT_ID
      ? AUTO_ACCOUNT_ID
      : hasExplicitAccount
        ? selected
        : loadBalancing
          ? AUTO_ACCOUNT_ID
          : effectiveDefaultId;
  const draftModel = composer.agent.model ?? null;
  // Offer usable accounts that are not known to be signed out (keep the currently selected one visible if already picked).
  const selectable = data.accounts.filter(
    (account) => account.usable && (account.status !== "signed-out" || account.id === activeValue),
  );
  const candidates = selectable.length > 0 ? selectable : data.accounts.filter((account) => account.usable);
  // Compute the Auto recommendation specifically for this draft's model rather than the global default.
  const recommendedAuto = pickBestLocal(data.accounts, draftModel, data.fallback.strategy);
  const recommendedName = recommendedAuto ? displayLabel(recommendedAuto.label, t, recommendedAuto.kind) : null;

  const autoOption = loadBalancing
    ? {
        value: AUTO_ACCOUNT_ID,
        label: t("composerAuto"),
        description: t("composerAutoDesc"),
      }
    : {
        value: AUTO_ACCOUNT_ID,
        label: t("auto.label"),
        description: recommendedName
          ? t("auto.composerDescription", { account: recommendedName })
          : t("auto.noEligible"),
      };

  const options = [
    autoOption,
    ...candidates.map((account) => {
      const name = displayLabel(account.label, t, account.kind);
      const email = account.kind === "profile" && account.status === "signed-out" ? null : account.email;
      const planTag = shortPlan(account.plan, name);
      const quota = compactQuotaSummary(account, draftModel, locale);
      const cooling = activeCooldownForModel(account, draftModel);
      const supported = accountSupportsModel(account, draftModel);
      const detail = [
        account.note,
        supported === false ? t("modelUnsupported") : null,
        cooling ? t("coolingShort") : null,
        planTag,
        email ?? t(`kind.${account.kind}`),
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        value: account.id,
        label: quota ? `${name} · ${quota}` : name,
        description:
          account.status === "signed-in" && quota
            ? detail
            : t("composerDescription", { detail, status: t(`status.${account.status}`) }),
      };
    }),
  ];
  return (
    <Select
      title={t("account")}
      icon={activeValue === AUTO_ACCOUNT_ID ? (loadBalancing ? "Gauge" : "Sparkles") : "UserRound"}
      value={activeValue}
      options={options}
      // An explicit value keeps that choice even when the global default changes later.
      onValueChange={({ value }) => composer.setMetadata({ [ACCOUNT_METADATA_KEY]: value })}
    />
  );
}

/** Account picker for drafts and the New workspace composer; running agents use the pill. */
export function ComposerAccount() {
  const composer = useComposer();
  if (composer.context === "agent" || !isAntigravityProvider(composer.agent.provider)) return null;
  return <DraftAccount composer={composer} />;
}
