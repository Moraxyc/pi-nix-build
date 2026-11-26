{
  lib,
  stdenvNoCC,
  nodejs,
  esbuild,
}:
let
  manifest = lib.importJSON ../package.json;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = manifest.name;
  inherit (manifest) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../src
    ];
  };

  nativeBuildInputs = [
    nodejs
    esbuild
  ];

  buildPhase = ''
    runHook preBuild
    npm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/${finalAttrs.pname}
    cp -r package.json dist $out/lib/${finalAttrs.pname}/
    runHook postInstall
  '';

  meta.description = "pi extension for Nix builds with live progress";
})
