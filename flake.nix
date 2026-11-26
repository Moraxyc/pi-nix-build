{
  description = "pi extension for Nix builds with live progress";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              typescript
              biome
              nixfmt
            ];
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.treefmt.withConfig {
          runtimeInputs = with pkgs; [
            biome
            nixfmt
          ];
          settings = {
            on-unmatched = "info";
            tree-root-file = "flake.nix";
            formatter.biome = {
              command = "biome";
              options = [
                "format"
                "--write"
              ];
              includes = [
                "*.ts"
                "*.json"
              ];
            };
            formatter.nixfmt = {
              command = "nixfmt";
              includes = [ "*.nix" ];
            };
          };
        }
      );
    };
}
