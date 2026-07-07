import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { SHARED_ANNOTATIONS } from "@vault-mcp/core";
import type { ToolAnnotations } from "@vault-mcp/core";
import { ok, fail } from "./helpers.js";
import { jsonSchemaToZodShape, type JsonSchemaObject } from "./json-schema-to-zod.js";
import { collectPaths } from "../guard.js";
import type { ServerCtx } from "./tools-core.js";

// ── Public boundary types (mirrored in the vault-mcp-api SDK — keep in sync) ──

export interface ExternalToolSpec {
  /** Bare tool name, /^[a-z][a-z0-9_]*$/; published as `${sanitizedOwnerId}_${name}`. */
  name: string;
  description: string;
  /** Plain JSON Schema only — zod instances must not cross the plugin boundary. */
  inputSchema?: JsonSchemaObject;
  /** Absent ⇒ treated as MUTATING (blocked in read-only mode). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface ExternalToolEntry {
  ownerId: string;   // raw plugin id as passed by the publisher
  toolName: string;  // namespaced published name
  spec: ExternalToolSpec;
}

export interface VaultMcpApi {
  apiVersion: 1;
  registerTools(ownerPluginId: string, tools: ExternalToolSpec[]): () => void;
  unregisterTools(ownerPluginId: string): void;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function sanitizeOwnerId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export class ExternalToolRegistry {
  private byName = new Map<string, ExternalToolEntry>();

  registerTools(ownerPluginId: string, tools: ExternalToolSpec[]): () => void {
    const owner = sanitizeOwnerId(ownerPluginId);
    if (!owner) throw new TypeError(`vault-mcp: unusable owner plugin id '${ownerPluginId}'`);
    // Validate everything before inserting anything — a mid-array failure
    // must not leave earlier specs registered with no disposer.
    for (const spec of tools) {
      if (!NAME_RE.test(spec.name))
        throw new TypeError(`vault-mcp: invalid tool name '${spec.name}' (must match ${NAME_RE})`);
      if (typeof spec.handler !== "function")
        throw new TypeError(`vault-mcp: tool '${spec.name}' handler is not a function`);
      const toolName = `${owner}_${spec.name}`;
      // F1: reject names that collide with the built-in obsidian_* namespace.
      if (toolName.startsWith("obsidian_"))
        throw new TypeError(`vault-mcp: tool name '${toolName}' collides with the reserved obsidian_* namespace`);
      // F4: reject cross-owner clobbering (same-owner replace is by design).
      const existing = this.byName.get(toolName);
      if (existing && existing.ownerId !== ownerPluginId)
        throw new TypeError(`vault-mcp: tool '${toolName}' is already published by plugin '${existing.ownerId}'`);
      // F8: reject zod schemas and other non-JSON-Schema values.
      if (spec.inputSchema !== undefined) {
        const s = spec.inputSchema as unknown;
        if (
          typeof s !== "object" || s === null ||
          (s as any).type !== "object" ||
          ((s as any).properties !== undefined &&
            (typeof (s as any).properties !== "object" ||
              Array.isArray((s as any).properties) ||
              (s as any).properties === null))
        ) {
          throw new TypeError(
            `vault-mcp: tool '${spec.name}' inputSchema must be a plain JSON Schema object ({ type: "object", … }) — zod schemas must be converted before crossing the plugin boundary (use the vault-mcp-api SDK)`
          );
        }
      }
    }
    const added: ExternalToolEntry[] = [];
    for (const spec of tools) {
      const entry: ExternalToolEntry = { ownerId: ownerPluginId, toolName: `${owner}_${spec.name}`, spec };
      this.byName.set(entry.toolName, entry); // replace-on-re-register, by design
      added.push(entry);
    }
    // Object-identity check makes the disposer idempotent AND stops a stale
    // disposer from deleting a newer replacement registered under the same name.
    return () => {
      for (const e of added) if (this.byName.get(e.toolName) === e) this.byName.delete(e.toolName);
    };
  }

  unregisterTools(ownerPluginId: string): void {
    for (const [name, e] of this.byName) if (e.ownerId === ownerPluginId) this.byName.delete(name);
  }

  entries(): ExternalToolEntry[] {
    return Array.from(this.byName.values());
  }
}

// Called from buildMcpServer AFTER the guard monkeypatch, so external tools are
// guarded by read-only mode. Restrictive default: external tools are mutating
// unless they explicitly declare readOnlyHint: true (built-ins use the inverse
// convention — mutating iff readOnlyHint === false — which the guard keys on).
// When a path allowlist is configured, mutating tools whose args contain no
// recognized path field are blocked outright (allowlist bypass prevention).
export function registerExternalTools(server: McpServer, app: App, ctx: ServerCtx): void {
  const entries = ctx.getExternalTools?.() ?? [];
  for (const { ownerId, toolName, spec } of entries) {
    // F7: widen annotations passthrough — base from readOnlyHint, then overlay
    // explicit destructiveHint / idempotentHint when provided by the publisher.
    const base: ToolAnnotations = spec.annotations?.readOnlyHint === true
      ? { ...SHARED_ANNOTATIONS.RO }
      : { ...SHARED_ANNOTATIONS.RW };
    if (spec.annotations?.destructiveHint !== undefined) base.destructiveHint = spec.annotations.destructiveHint;
    if (spec.annotations?.idempotentHint  !== undefined) base.idempotentHint  = spec.annotations.idempotentHint;
    const annotations = base;

    // F6: snapshot the owner plugin instance at connection-build time.
    // Any change (reload or unload) detected at call time → stale-session error.
    const ownerAtBuild = (app as any).plugins?.plugins?.[ownerId];

    // Backstop: a bad entry must never break connection building.
    try {
      server.registerTool(
        toolName,
        {
          title: toolName,
          description: spec.description,
          inputSchema: jsonSchemaToZodShape(spec.inputSchema),
          annotations,
        },
        async (args: Record<string, unknown>) => {
          // F6: require exact same plugin instance as at build time.
          // Covers both unload (undefined !== instance) and hot-reload (newObj !== instance).
          // Also catches entries whose owner was absent at build time (undefined identity).
          const currentOwner = (app as any).plugins?.plugins?.[ownerId];
          if (ownerAtBuild === undefined || currentOwner !== ownerAtBuild)
            return fail(new Error(`publisher plugin '${ownerId}' was reloaded or unloaded since this session connected; reconnect to use its tools`));
          // F3: when an allowlist is active, mutating tools that carry no recognized
          // path argument cannot be scoped — block them outright.
          const isReadOnly = spec.annotations?.readOnlyHint === true;
          if (!isReadOnly) {
            const settings = ctx.getSettings();
            if (settings.allowlist.length > 0 && collectPaths(args ?? {}).length === 0)
              return fail(new Error(
                `'${toolName}' is blocked: a path allowlist is configured but this tool's arguments carry no recognized path field (path, from, to, paths, …), so the call cannot be scoped. Use recognized path argument names or clear the allowlist.`
              ));
          }
          // F5: normalize handler return value to a plain object so ok() emits
          // valid structuredContent (undefined, primitives, and arrays all wrapped).
          try {
            const r = await spec.handler(args ?? {});
            const data =
              r === undefined                                          ? { ok: true } :
              (typeof r === "object" && r !== null && !Array.isArray(r)) ? r :
              { result: r };
            return ok(data);
          } catch (e) {
            return fail(e);
          }
        }
      );
    } catch (e) {
      console.error("[vault-mcp] skipping external tool", toolName, e);
    }
  }
}
