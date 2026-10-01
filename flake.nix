{
    description = "dim-teleop: keyboard teleop over zenoh-web, as a dimOS Desktop app";

    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            packages = forAllSystems (pkgs: {
                # a static page, served at /apps/<name>/; the rail icon rides along for the page's own use
                dimosApp = pkgs.runCommand "dim-teleop" { } ''
                    cp -r ${self}/dim/apps/teleop/frontend $out
                    chmod -R u+w $out
                    cp ${self}/icon.svg $out/icon.svg
                    # nothing to build (a plain-JS page); parse its module script so a broken edit fails the build
                    ${pkgs.gawk}/bin/awk '/<script type="module">/{on=1; next} /<\/script>/{on=0} on' $out/index.html \
                        | ${pkgs.esbuild}/bin/esbuild --loader=js --format=esm --log-level=error > /dev/null
                '';
            });
        };
}
