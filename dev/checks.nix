{ inputs, lib, ... }:
{
  perSystem =
    { pkgs, self', ... }:
    let
      package = self'.packages.default;
    in
    {
      checks = {
        inherit package;

        typecheck = package.overrideAttrs (old: {
          pname = "${old.pname}-typecheck";
          src = lib.fileset.toSource {
            root = ../.;
            fileset = lib.fileset.unions [
              ../package.json
              ../package-lock.json
              ../tsconfig.json
              ../src
              ./check-upstream.ts
            ];
          };
          nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.typescript ];
          npmBuildScript = "typecheck";
          installPhase = "touch $out";
        });

        lint =
          pkgs.runCommand "biome-lint"
            {
              nativeBuildInputs = [ pkgs.biome ];
              src = lib.fileset.toSource {
                root = ../.;
                fileset = lib.fileset.unions [
                  ../biome.json
                  ../src
                  ./check-upstream.ts
                ];
              };
            }
            ''
              cd $src
              # The sandbox has no .git, so the vcs settings in biome.json cannot apply.
              biome lint --vcs-enabled=false
              touch $out
            '';

        upstream =
          pkgs.runCommand "check-upstream"
            {
              nativeBuildInputs = [ pkgs.nodejs ];
              src = lib.fileset.toSource {
                root = ../.;
                fileset = lib.fileset.unions [
                  ../src/nix
                  ./check-upstream.ts
                ];
              };
            }
            ''
              cd $src
              node dev/check-upstream.ts ${inputs.nix} ${inputs.nixpkgs}
              touch $out
            '';
      };
    };
}
