function shellQuote(s: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildRegisterCommand(opts: { bridgePath: string; vaultName: string }): string {
  return `claude mcp add --scope user vault-mcp -- node ${shellQuote(opts.bridgePath)} --vault ${shellQuote(opts.vaultName)}`;
}
