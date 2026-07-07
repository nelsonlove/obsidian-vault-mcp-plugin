import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "obsidian";
import { ok, fail } from "./helpers.js";
import { jsonSchemaToZodShape, type JsonSchemaObject } from "./json-schema-to-zod.js";

// ── Public boundary types (mirrored in the vault-mcp-api SDK — keep in sync) ──

export interface ExternalToolSpec {
  /** Bare tool name, /^[a-z][a-z0-9_]*$/; published as `${sanitizedOwnerId}_${name}`. */
  name: string;
  description: string;
  /** Plain JSON Schema only — zod instances must not cross the plugin boundary. */
  inputSchema?: JsonSchemaObject;
  /** Absent ⇒ treated as MUTATING (blocked in read-only mode). */
  annotations?: { readOnlyHint?: boolean };
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

const RO = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// Called from buildMcpServer AFTER the guard monkeypatch, so external tools are
// guarded like built-ins. Restrictive default: external tools are mutating
// unless they explicitly declare readOnlyHint: true (built-ins use the inverse
// convention — mutating iff readOnlyHint === false — which the guard keys on).
export function registerExternalTools(server: McpServer, app: App, entries: ExternalToolEntry[]): void {
  for (const { ownerId, toolName, spec } of entries) {
    const annotations = spec.annotations?.readOnlyHint === true ? RO : RW;
    server.registerTool(
      toolName,
      {
        title: toolName,
        description: spec.description,
        inputSchema: jsonSchemaToZodShape(spec.inputSchema),
        annotations,
      },
      async (args: Record<string, unknown>) => {
        // Gate on the LOADED instance (same rule as plugin-gated integrations):
        // the publisher may have been disabled since this connection was built.
        if (!(app as any).plugins?.plugins?.[ownerId])
          return fail(new Error(`publisher plugin '${ownerId}' is no longer loaded`));
        try { return ok(await spec.handler(args ?? {})); }
        catch (e) { return fail(e); }
      }
    );
  }
}
