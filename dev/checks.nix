{ inputs, lib, ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      checks.upstream =
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
}
