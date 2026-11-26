{
  description = "Development-only inputs for pi-nix-build, loaded by the root flake's dev partition";

  inputs = {
    # Upstream source for checks.upstream.
    nix = {
      url = "github:NixOS/nix";
      flake = false;
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "";
    };
    git-hooks-nix = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "";
      inputs.flake-compat.follows = "";
    };
  };

  outputs = _: { };
}
