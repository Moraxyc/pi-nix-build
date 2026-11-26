{ inputs, lib, ... }:
{
  imports = [
    inputs.treefmt-nix.flakeModule
    inputs.git-hooks-nix.flakeModule
    ./checks.nix
  ];

  perSystem =
    { config, pkgs, ... }:
    {
      treefmt = {
        projectRootFile = "flake.nix";
        programs.nixfmt.enable = true;
        programs.biome = {
          enable = true;
          # treefmt-nix always passes --config-path, so mirror the repo config the CLI and editors use.
          # vcs is dropped: its root would resolve to the generated config in the store.
          settings = removeAttrs (lib.importJSON ../biome.json) [ "vcs" ];
        };
        # treefmt-nix limits biome to JS, JSON and CSS; `biome check` also formats these.
        settings.formatter.biome.includes = [
          "*.md"
          "*.yml"
          "*.yaml"
        ];
        settings.excludes = [ "*.webp" ];
      };

      pre-commit = {
        # treefmt-nix already adds the same check to `nix flake check`.
        check.enable = false;
        settings.hooks.treefmt = {
          enable = true;
          package = config.treefmt.build.wrapper;
        };
      };

      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs
          esbuild
          typescript
          biome
          config.treefmt.build.wrapper
        ];
        shellHook = config.pre-commit.installationScript;
      };
    };
}
