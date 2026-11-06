import { richTextFields, withDefaults, type InferShape, type Shape } from "./fields";
import { personalScope, spaceScope } from "./identity";
import { LocalLiveCollection, type CollectionHandle } from "./live";
import { services, type ServiceClient } from "./services";

/* An app's declaration — its collections, the services it calls, the
   operations it offers agents — and the `app` object read from it: each
   collection's handle, each service's client, and `commands()`. */

export interface CollectionDefinition {
  fields: Shape;
  scopes?: readonly string[];
  agents?: string;
  retention?: Record<string, unknown>;
}

export interface OperationDefinition {
  runs: string;
  effect: string;
  description: string;
  input: Shape;
}

export interface AppDefinition<
  C extends Record<string, CollectionDefinition>,
  S extends Record<string, string>,
  O extends Record<string, OperationDefinition>,
> {
  collections: C;
  services?: S;
  operations?: O;
}

/** What an operation's handler is given and may answer. */
export type Handlers<O extends Record<string, OperationDefinition>> = {
  [K in keyof O]?: (input: InferShape<O[K]["input"]>) => unknown;
};

export type App<
  C extends Record<string, CollectionDefinition>,
  S extends Record<string, string>,
  O extends Record<string, OperationDefinition>,
> = { readonly [K in keyof C]: CollectionHandle<InferShape<C[K]["fields"]>> }
  & { readonly [K in keyof S]: ServiceClient }
  & {
    /** Offers the operations to agents; answers how to take them back. */
    commands(handlers: Handlers<O>): () => void;
  };

/** The operations this tab offers, for calling by hand from the console:
 *  `await __notesCommands.findPages({ query: "" })`. */
declare global {
  interface Window {
    __notesCommands?: Record<string, (input?: unknown) => Promise<unknown>>;
  }
}

function handle<R>(name: string, richFields: readonly string[], scope: () => string): CollectionHandle<R> {
  return {
    name,
    live: () => LocalLiveCollection.open<R>(`${scope()}|${name}`, richFields),
    in: (spaceId: string) => handle<R>(name, richFields, () => spaceScope(spaceId)),
  };
}

export function schema<
  C extends Record<string, CollectionDefinition>,
  S extends Record<string, string> = Record<never, string>,
  O extends Record<string, OperationDefinition> = Record<never, OperationDefinition>,
>(definition: AppDefinition<C, S, O>): App<C, S, O> {
  const app: Record<string, unknown> = {};
  for (const [name, collection] of Object.entries(definition.collections)) {
    app[name] = handle(name, richTextFields(collection.fields), () => personalScope());
  }
  for (const name of Object.keys(definition.services ?? {})) app[name] = services;
  const operations = definition.operations ?? {};
  app.commands = (handlers: Record<string, ((input: unknown) => unknown) | undefined>) => {
    const offered: Record<string, (input?: unknown) => Promise<unknown>> = {};
    for (const [name, run] of Object.entries(handlers)) {
      const operation = (operations as Record<string, OperationDefinition>)[name];
      if (!run || !operation) continue;
      offered[name] = async (input?: unknown) => run(withDefaults(operation.input, input));
    }
    if (typeof window !== "undefined") window.__notesCommands = offered;
    return () => {
      if (typeof window !== "undefined" && window.__notesCommands === offered) delete window.__notesCommands;
    };
  };
  return app as App<C, S, O>;
}
