{
  description = "Hades — Kubernetes-native agent operating system";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin"];
    forAll = fn:
      nixpkgs.lib.genAttrs systems (system:
        fn nixpkgs.legacyPackages.${system});
  in {
    devShells = forAll (pkgs: {
      default = pkgs.mkShell {
        packages = with pkgs; [
          # JS / Node (24 for built-in node:sqlite)
          nodejs_24
          # k8s dev workflow — dev IS a kind cluster.
          # kubernetes-helm is the cross-platform attr (helm is Linux-only).
          kind
          kubectl
          tilt
          kubernetes-helm
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

    # `nix fmt` — project-wide Nix formatting (alejandra).
    formatter = forAll (pkgs: pkgs.alejandra);
  };
}
