{
  description = "Pinned development toolchain for Muse's repositories. Tool and runtime versions are managed here: flake.nix + flake.lock are the source of truth.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };

      # --- Tools that nixpkgs does not ship at the exact pinned version ---
      # Each is a fixed-output fetch of the official release artifact with
      # its SHA-256 pinned here, so Nix verifies the content exactly like
      # the previous curl + sha256sum steps in CI did. The pinned hashes
      # were verified against the publishers' own checksum files where
      # those exist (gh, lefthook) or taken from the previously
      # CI-verified downloads (jactionlint, sisakulint, betterleaks).

      # GitHub CLI (used for GitHub operations and the Alchemy program).
      gh = pkgs.stdenvNoCC.mkDerivation {
        pname = "gh";
        version = "2.103.3";
        src = pkgs.fetchurl {
          url = "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz";
          sha256 = "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d";
        };
        sourceRoot = ".";
        installPhase = ''
          runHook preInstall
          install -Dm755 gh_*/bin/gh $out/bin/gh
          runHook postInstall
        '';
      };

      # pnpm standalone bundle (executable plus its dist/ directory).
      pnpm = pkgs.stdenvNoCC.mkDerivation {
        pname = "pnpm";
        version = "12.16.1";
        src = pkgs.fetchurl {
          url = "https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-linux-x64.tar.gz";
          sha256 = "565ff81174a14f6f7bd5d84c1b17e51031a80230d370a1fe24be5d16bd02a825";
        };
        sourceRoot = ".";
        installPhase = ''
          runHook preInstall
          mkdir -p $out/lib/pnpm $out/bin
          cp -r pnpm dist $out/lib/pnpm/
          chmod +x $out/lib/pnpm/pnpm
          ln -s ../lib/pnpm/pnpm $out/bin/pnpm
          runHook postInstall
        '';
      };

      jactionlint = pkgs.stdenvNoCC.mkDerivation {
        pname = "jactionlint";
        version = "2.4.0";
        src = pkgs.fetchurl {
          url = "https://github.com/jdx/jactionlint/releases/download/v2.4.0/jactionlint_2.4.0_linux_amd64.tar.gz";
          sha256 = "26ddba81db28fffc51163175c070ee1a9d1150260de4b5232f01d9b749f32d8e";
        };
        sourceRoot = ".";
        installPhase = ''
          runHook preInstall
          install -Dm755 jactionlint $out/bin/jactionlint
          runHook postInstall
        '';
      };

      sisakulint = pkgs.stdenvNoCC.mkDerivation {
        pname = "sisakulint";
        version = "0.3.8";
        src = pkgs.fetchurl {
          url = "https://github.com/sisaku-security/sisakulint/releases/download/v0.3.8/sisakulint_0.3.8_linux_amd64.tar.gz";
          sha256 = "6da250932db1cc6fae8b8f44185acacb6e6ffc16dbafb90b1a37a25ad3ad21df";
        };
        sourceRoot = ".";
        installPhase = ''
          runHook preInstall
          install -Dm755 sisakulint $out/bin/sisakulint
          runHook postInstall
        '';
      };

      betterleaks = pkgs.stdenvNoCC.mkDerivation {
        pname = "betterleaks";
        version = "1.9.0";
        src = pkgs.fetchurl {
          url = "https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/betterleaks_1.9.0_linux_x64.tar.gz";
          sha256 = "f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7";
        };
        sourceRoot = ".";
        installPhase = ''
          runHook preInstall
          install -Dm755 betterleaks $out/bin/betterleaks
          runHook postInstall
        '';
      };

      # lefthook ships as a bare gzipped binary (nixpkgs lags at 2.1.x).
      lefthook = pkgs.stdenvNoCC.mkDerivation {
        pname = "lefthook";
        version = "2.2.2";
        src = pkgs.fetchurl {
          url = "https://github.com/evilmartians/lefthook/releases/download/v2.2.2/lefthook_2.2.2_Linux_x86_64.gz";
          sha256 = "2b8d7fd52771f26d7a50260ef10cd6fe704d66f60102e566362b84da09884ab7";
        };
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.gzip ];
        installPhase = ''
          runHook preInstall
          gunzip -c $src > lefthook
          install -Dm755 lefthook $out/bin/lefthook
          runHook postInstall
        '';
      };
    in
    {
      packages.${system} = {
        inherit gh pnpm jactionlint sisakulint betterleaks lefthook;
        # Re-exported from the locked nixpkgs so CI can pull exactly
        # these (and only these) per job via `nix shell`.
        nodejs_26 = pkgs.nodejs_26;
        shellcheck = pkgs.shellcheck;
        pyflakes = pkgs.python312Packages.pyflakes;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          # Runtimes from nixpkgs (versions pinned by flake.lock):
          pkgs.nodejs_26 # 26.13.0
          pkgs.python315 # 3.15.0
          pkgs.go # 1.26.10
          pkgs.shellcheck # 0.11.0
          # Exact-version tools (custom derivations above):
          gh
          pnpm
          jactionlint
          sisakulint
          betterleaks
          lefthook
          # jactionlint runs its pyflakes integration when pyflakes is on PATH.
          pkgs.python312Packages.pyflakes
        ];
      };
    };
}
