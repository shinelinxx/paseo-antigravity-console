import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { modelRatesSchema, type PricingModelRow, type PricingState } from "../shared/contracts";
import { DEFAULT_PRICING, defaultPricingEntry, officialRatesAt, resolvePricingKey, type ModelRates } from "../shared/pricing";
import { dataDir } from "./paths";

const pricingFile = () => path.join(dataDir(), "pricing.json");

const fileSchema = z.object({
  version: z.literal(1).default(1),
  overrides: z.record(z.string(), modelRatesSchema).default({}),
});

/** Stores user-customized per-model API rates (USD per 1M tokens) alongside official defaults. */
export class PricingStore {
  private overrides: Record<string, ModelRates> = {};
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  async load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(pricingFile(), "utf8")) as unknown;
        const parsed = fileSchema.parse(raw);
        this.overrides = parsed.overrides;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "ENOENT") {
          console.error("antigravity-accounts: could not read pricing.json, using official defaults", error);
        }
        this.overrides = {};
      }
    })();
    return this.loaded;
  }

  snapshot(): Record<string, ModelRates> {
    return structuredClone(this.overrides);
  }

  hasCustomOverrides(): boolean {
    return Object.keys(this.overrides).length > 0;
  }

  private async persist(next: Record<string, ModelRates>): Promise<void> {
    const run = this.writing.then(async () => {
      const validated = fileSchema.parse({ version: 1, overrides: next });
      const file = pricingFile();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${Date.now()}.${++this.writeSeq}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temp, file);
      this.overrides = validated.overrides;
    });
    this.writing = run.catch(() => undefined);
    await run;
  }

  async update(input: { key?: string; rates?: ModelRates | null; resetAll?: boolean }): Promise<void> {
    await this.load();
    const next = structuredClone(this.overrides);
    if (input.resetAll) {
      await this.persist({});
      return;
    }
    const raw = input.key?.trim().toLowerCase();
    if (!raw) throw new Error("Choose a model key to update.");
    const canonical = resolvePricingKey(raw, null);
    if (input.rates === null || input.rates === undefined) {
      delete next[raw];
      delete next[canonical];
    } else {
      if (raw !== canonical) delete next[raw];
      next[canonical] = modelRatesSchema.parse(input.rates);
    }
    await this.persist(next);
  }

  /** Builds the complete pricing table combining official entries, custom overrides, and seen models. */
  async state(seenModels: ReadonlyMap<string, string> = new Map()): Promise<PricingState> {
    await this.load();
    const now = Date.now();
    const rows: PricingModelRow[] = [];
    const listed = new Set<string>();

    for (const entry of DEFAULT_PRICING) {
      listed.add(entry.key);
      const official = officialRatesAt(entry, now);
      const custom = this.overrides[entry.key] ?? null;
      rows.push({
        key: entry.key,
        label: entry.label,
        provider: entry.provider,
        official,
        custom,
        effective: custom ?? official,
        note: entry.note ?? null,
        seenLocally: seenModels.has(entry.key),
      });
    }

    // Add any custom keys or unrecognized models seen in local conversations.
    const extras = new Set<string>([...Object.keys(this.overrides), ...seenModels.keys()]);
    for (const key of [...extras].sort((a, b) => a.localeCompare(b))) {
      if (listed.has(key) || defaultPricingEntry(key)) continue;
      const custom = this.overrides[key] ?? null;
      rows.push({
        key,
        label: seenModels.get(key) ?? key,
        provider: null,
        official: null,
        custom,
        effective: custom,
        note: null,
        seenLocally: seenModels.has(key),
      });
    }

    // Put models observed on this host (or customized by the user) first, keeping catalog order within groups.
    rows.sort((a, b) => {
      const aRank = a.seenLocally || a.custom ? 0 : 1;
      const bRank = b.seenLocally || b.custom ? 0 : 1;
      return aRank - bRank;
    });

    return { models: rows, overrides: this.snapshot() };
  }
}
