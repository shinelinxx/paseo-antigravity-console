import {
  useRpc,
  type PluginClientContext,
  type PluginSubscriptionHandle,
  type PluginSubscriptionState,
} from "@getpaseo/plugin/client";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { listAccountsRpc, watchAccountsSubscription, type AccountsState } from "../shared/contracts";

const key = ["antigravity-accounts", "state"] as const;
const CONNECTING: PluginSubscriptionState = { status: "connecting" };
const LIVE: PluginSubscriptionState = { status: "live" };
const CLOSED: PluginSubscriptionState = { status: "closed" };

export const AccountsClientContext = createContext<PluginClientContext | null>(null);

interface SharedWatch {
  refs: number;
  observed: number;
  state: PluginSubscriptionState;
  listeners: Set<() => void>;
  handle: PluginSubscriptionHandle;
}

const sharedByClient = new WeakMap<PluginClientContext, WeakMap<QueryClient, SharedWatch>>();

function acquireSharedWatch(client: PluginClientContext, cache: QueryClient): SharedWatch {
  let byCache = sharedByClient.get(client);
  if (!byCache) {
    byCache = new WeakMap();
    sharedByClient.set(client, byCache);
  }
  const existing = byCache.get(cache);
  if (existing) {
    existing.refs += 1;
    return existing;
  }
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let active = true;
  const entry: SharedWatch = {
    refs: 1,
    observed: -1,
    state: CONNECTING,
    listeners,
    handle: null as unknown as PluginSubscriptionHandle,
  };
  try {
    const rawHandle = client.subscribe(
      watchAccountsSubscription,
      {},
      ({ revision }) => {
        entry.observed = Math.max(entry.observed, revision);
        if (revision > (cache.getQueryData<AccountsState>(key)?.revision ?? -1)) {
          void cache.invalidateQueries({ queryKey: key });
        }
      },
      {
        onClosed: ({ error }) => {
          if (!active) return;
          entry.state = error ? { status: "error", error } : CLOSED;
          notify();
        },
      },
    );
    entry.handle = Object.assign(
      () => {
        active = false;
        rawHandle();
      },
      { ready: rawHandle.ready, release: rawHandle.release },
    );
    void rawHandle.ready.then(
      () => {
        if (!active) return;
        if (entry.state.status === "connecting") {
          entry.state = LIVE;
          notify();
        }
      },
      (error: unknown) => {
        if (!active) return;
        entry.state = {
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        notify();
      },
    );
  } catch (error) {
    entry.state = {
      status: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
    entry.handle = Object.assign(() => undefined, {
      ready: Promise.resolve(),
      release: async () => undefined,
    });
  }
  byCache.set(cache, entry);
  return entry;
}

function releaseSharedWatch(client: PluginClientContext, cache: QueryClient, entry: SharedWatch): void {
  entry.refs -= 1;
  if (entry.refs <= 0) {
    const byCache = sharedByClient.get(client);
    if (byCache?.get(cache) === entry) byCache.delete(cache);
    entry.listeners.clear();
    entry.handle();
  }
}

export function useAccounts() {
  const list = useRpc(listAccountsRpc);
  const cache = useQueryClient();
  const client = useContext(AccountsClientContext);
  const [watch, setWatch] = useState<PluginSubscriptionState>(CONNECTING);
  const observed = useRef(-1);

  const query = useQuery({
    queryKey: key,
    queryFn: () => list({}),
    staleTime: Infinity,
    structuralSharing(old: unknown, next: unknown) {
      const previous = old as AccountsState | undefined;
      return previous && previous.revision > (next as AccountsState).revision ? previous : next;
    },
  });

  useEffect(() => {
    if (!client) return;
    const shared = acquireSharedWatch(client, cache);
    observed.current = Math.max(observed.current, shared.observed);
    setWatch(shared.state);
    const onState = () => {
      observed.current = Math.max(observed.current, shared.observed);
      setWatch(shared.state);
    };
    shared.listeners.add(onState);
    const current = cache.getQueryData<AccountsState>(key);
    if (current && current.revision < shared.observed) {
      void cache.invalidateQueries({ queryKey: key });
    }
    return () => {
      shared.listeners.delete(onState);
      releaseSharedWatch(client, cache, shared);
    };
  }, [client, cache]);

  // An event can arrive before the very first list request resolves.
  useEffect(() => {
    if (!client || !query.data) return;
    const shared = sharedByClient.get(client)?.get(cache);
    const seen = Math.max(observed.current, shared?.observed ?? -1);
    if (query.data.revision < seen) void cache.invalidateQueries({ queryKey: key });
  }, [client, cache, query.data, query.dataUpdatedAt]);

  // Guard against out-of-order RPC responses overwriting a newer revision in the cache.
  const accept = useCallback(
    (state: AccountsState) => {
      cache.setQueryData<AccountsState>(key, (previous) =>
        previous && previous.revision > state.revision ? previous : state,
      );
    },
    [cache],
  );
  return { ...query, watch, accept };
}
