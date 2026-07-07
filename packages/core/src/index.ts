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
