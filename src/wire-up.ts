import * as fs from "node:fs";

export function wireUpClaudeConfig(opts: {
  bridgePath: string;
  vaultName: string;
  configPath: string;
}): { added: boolean } {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(opts.configPath, "utf8")); } catch { cfg = {}; }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  cfg.mcpServers["vault-mcp"] = {
    command: "node",
    args: [opts.bridgePath, "--vault", opts.vaultName],
  };
  fs.writeFileSync(opts.configPath, JSON.stringify(cfg, null, 2));
  return { added: true };
}
