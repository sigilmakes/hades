{
  description = "Hades — Kubernetes-native agent operating system";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = fn: nixpkgs.lib.genAttrs systems (system:
        fn nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            # JS / Node (24 for built-in node:sqlite)
            nodejs_24
            # k8s dev workflow — dev IS a kind cluster
            kind
            kubectl
            tilt
            # image builds
            docker
            # misc
            jq
          ];

          shellHook = ''
            export PATH="$PWD/node_modules/.bin:$PATH"

            echo ""
            echo "  🏛  hades dev shell"
            echo ""
            echo "  Setup:    npm install && bash scripts/dev-setup.sh"
            echo "  Dev:      tilt up"
            echo "  Down:     tilt down"
            echo "  Reset:    kind delete cluster --name hades"
            echo ""
          '';
        };
      });
    };
}
