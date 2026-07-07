export { ok, fail } from "./responses.js";
export {
  SHARED_ANNOTATIONS,
  FS_TOOLS,
  PROP_RE,
  FmValue,
} from "./tool-registry.js";
export type { Capability, ToolDef, ToolAnnotations } from "./tool-registry.js";
export type {
  VaultBackend,
  FrontmatterScalar,
  FrontmatterEditValue,
  FrontmatterValue,
  NoteRef,
  SearchHit,
  SearchMode,
  ReadNoteResult,
  ReadNoteError,
  ReadNotesResult,
  PatchAnchor,
  PatchOp,
  ResolveResult,
  OutlinkEntry,
  FrontmatterSearchResult,
  ManageFrontmatterResult,
} from "./vault-backend.js";

// ── Filesystem backend ──────────────────────────────────────────────────────

export { FilesystemBackend } from "./fs-backend/filesystem-backend.js";

// Vault filesystem functions (module-level, bound to process.env.VAULT_PATH)
export {
  CHARACTER_LIMIT,
  decodeHtmlEntities,
  vaultRoot,
  resolveInVault,
  listNotes,
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  listFolders,
  findByTag,
  setFrontmatterField,
  deleteFrontmatterField,
  getFrontmatterField,
  patchNote,
  deleteNote,
  moveNote,
  createVaultAt,
} from "./fs-backend/vault.js";
export type { VaultImpl } from "./fs-backend/vault.js";

// Index store functions (module-level singleton) and per-instance class
export {
  buildIndex,
  indexStatus,
  resolveRefs,
  getBacklinks,
  getOutlinks,
  searchByFrontmatter,
  getIndexedFrontmatter,
  applyAddOrChange,
  applyUnlink,
  parseAllFrontmatter,
  parseOutlinks,
  IndexStore,
} from "./fs-backend/index-store.js";
export type { IndexStatus, IndexedNote } from "./fs-backend/index-store.js";

// Vault watcher
export { startVaultWatcher } from "./fs-backend/vault-watcher.js";
export type { VaultWatcherOptions, VaultWatcherHandle } from "./fs-backend/vault-watcher.js";
