{
  lib,
  buildNpmPackage,
  importNpmLock,
  esbuild,
}:
buildNpmPackage (finalAttrs: {
  pname = finalAttrs.passthru.manifest.name;
  inherit (finalAttrs.passthru.manifest) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../src
    ];
  };

  npmDeps = importNpmLock { npmRoot = finalAttrs.src; };
  inherit (importNpmLock) npmConfigHook;

  nativeBuildInputs = [ esbuild ];

  passthru.manifest = lib.importJSON ../package.json;

  meta.description = "pi extension for Nix builds with live progress";
})
