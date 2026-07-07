function shellQuote(s: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// Generic by default (single vault auto-selects). vaultName only for the
// multi-vault case, where it appends `--vault <name>`.
export function buildRegisterCommand(opts: { bridgePath: string; vaultName?: string }): string {
  const base = `claude mcp add --scope user vault-mcp -- node ${shellQuote(opts.bridgePath)}`;
  return opts.vaultName ? `${base} --vault ${shellQuote(opts.vaultName)}` : base;
}
