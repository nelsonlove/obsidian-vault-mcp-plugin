import type { JsonSchemaObject } from "./json-schema-to-zod.js";

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
    const added: ExternalToolEntry[] = [];
    for (const spec of tools) {
      if (!NAME_RE.test(spec.name))
        throw new TypeError(`vault-mcp: invalid tool name '${spec.name}' (must match ${NAME_RE})`);
      if (typeof spec.handler !== "function")
        throw new TypeError(`vault-mcp: tool '${spec.name}' handler is not a function`);
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
