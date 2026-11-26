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

      apps.showcase = {
        type = "app";
        meta.description = "Render the README animations in docs/assets from the current source";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "showcase";
            runtimeInputs = with pkgs; [
              nodejs
              resvg
              libwebp
            ];
            runtimeEnv.SHOWCASE_FONT_DIR = "${pkgs.nerd-fonts.jetbrains-mono}/share/fonts/truetype/NerdFonts/JetBrainsMono";
            # Runs the working tree, with its node_modules, rather than a copy in the store.
            text = ''
              if [ ! -d node_modules ]; then
                echo "run this from the repository root after npm ci" >&2
                exit 1
              fi
              exec node dev/showcase/main.ts "$@"
            '';
          }
        );
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
