import { useComposer, useTranslation, type PluginComposer } from "@getpaseo/plugin/client";
import { Select } from "@getpaseo/plugin/client/ui";
import { ACCOUNT_METADATA_KEY, SYSTEM_ACCOUNT_ID, isAntigravityProvider } from "../shared/contracts";
import { formatPoolQuota, poolQuotaInfo } from "./agents";
import { displayLabel, shortPlan } from "./labels";
import { messages } from "./messages";
import { useAccounts } from "./useAccounts";

function DraftAccount({ composer }: { composer: PluginComposer }) {
  const { data } = useAccounts();
  const { t, locale } = useTranslation(messages);
  if (!data) return null;
  const selected = composer.agent.metadata[ACCOUNT_METADATA_KEY];
  const hasSelected = typeof selected === "string" && data.accounts.some((account) => account.id === selected);
  const configuredDefault = data.accounts.find((account) => account.id === data.defaultAccountId);
  const effectiveDefaultId =
    configuredDefault && (!configuredDefault.usable || configuredDefault.status === "signed-out")
      ? (data.accounts.find((account) => account.id === SYSTEM_ACCOUNT_ID && account.usable)?.id ?? data.defaultAccountId)
      : data.defaultAccountId;
  const activeValue = hasSelected ? selected : effectiveDefaultId;
  // Offer usable accounts that are not known to be signed out (keep the currently selected one visible if already picked).
  const selectable = data.accounts.filter(
    (account) => account.usable && (account.status !== "signed-out" || account.id === activeValue),
  );
  const candidates = selectable.length > 0 ? selectable : data.accounts.filter((account) => account.usable);
  const options = candidates.map((account) => {
    const name = displayLabel(account.label, t, account.kind);
    const email = account.kind === "profile" && account.status === "signed-out" ? null : account.email;
    const planTag = shortPlan(account.plan, name);
    const quotaText =
      account.usable && account.status === "signed-in"
        ? formatPoolQuota(poolQuotaInfo(account.quota, composer.agent.model), locale)
        : null;
    const status = quotaText ? null : t(`status.${account.status}`);
    return {
      value: account.id,
      label: quotaText ? `${name} · ${quotaText}` : name,
      description: [status, planTag, email ?? t(`kind.${account.kind}`)].filter(Boolean).join(" · "),
    };
  });
  return (
    <Select
      title={t("account")}
      icon="UserRound"
      value={activeValue}
      options={options}
      // An explicit "default" keeps the system sign-in even when another account is the default.
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
