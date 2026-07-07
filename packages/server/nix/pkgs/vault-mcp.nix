{ lib, buildNpmPackage, nodejs_22 }:

buildNpmPackage {
  pname = "obsidian-vault-mcp-server";
  version = "1.0.0";

  # The repo root is two levels up from this file (nix/pkgs/).
  src = lib.cleanSource ../..;

  nodejs = nodejs_22;

  # FILL THIS IN once, the standard way:
  #   1. leave lib.fakeHash here, run `nix build .#vault-mcp`
  #   2. the build fails and prints the correct hash ("got: sha256-...")
  #   3. paste that value here and rebuild.
  # This is the one value that can't be precomputed without Nix in hand.
  npmDepsHash = "sha256-KFn+PdrtAKUvLoY0+QMDUBVltYE76vxbEAnAbgNIsDk=";

  # `npm run build` (tsc) emits dist/. buildNpmPackage runs it via npmBuildScript.
  npmBuildScript = "build";

  # We only ship dist/ + node_modules; install them under the package and expose
  # a `vault-mcp` launcher on PATH.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/vault-mcp $out/bin
    cp -r dist $out/lib/vault-mcp/
    cp -r node_modules $out/lib/vault-mcp/
    cp package.json $out/lib/vault-mcp/
    cat > $out/bin/vault-mcp <<EOF
    #!${nodejs_22}/bin/node
    require("$out/lib/vault-mcp/dist/index.js");
    EOF
    chmod +x $out/bin/vault-mcp
    runHook postInstall
  '';

  meta = {
    description = "Remote (Streamable HTTP) MCP server exposing an Obsidian vault";
    mainProgram = "vault-mcp";
  };
}
