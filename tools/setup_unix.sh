#!/bin/sh
# One-time setup for building OpenXComZX on macOS (Homebrew) or Linux.
#   sh tools/setup_unix.sh
# macOS: installs the Homebrew packages. Linux: install the packages from your distribution
# first (see LINUX_PACKAGES below; PowerShell - from Microsoft's repository).
# Fetches the OpenXcom rules, strings and fonts the data converter needs into REF/OpenXcom
# (a clone of github.com/OpenXcom/OpenXcom at OPENXCOM_COMMIT) when they are missing.
# Then builds SDCC 4.5.0 (Z80 port only) into tmp/toolchain/sdcc-4.5.0 - CMakeLists.txt
# finds it before PATH.
# SDCC must be exactly 4.5.0: the code works around its code generation bugs
# (CLAUDE.md, tools/checkasm.js); Homebrew ships a newer one.
# Then: pwsh tools/build.ps1 [-Game TFTD|UFO] [-GameDir <original game folder>]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SDCC_VERSION=4.5.0
SDCC_SHA256=d5030437fb436bb1d93a8dbdbfb46baaa60613318f4fb3f5871d72815d1eed80
SDCC_URL="https://sourceforge.net/projects/sdcc/files/sdcc/$SDCC_VERSION/sdcc-src-$SDCC_VERSION.tar.bz2/download"
TOOLCHAIN="$ROOT/tmp/toolchain"
PREFIX="$TOOLCHAIN/sdcc-$SDCC_VERSION"
OS=$(uname -s)
# pwsh - build scripts; node - build helpers and the data converter (tools/oxzconv);
# cmake/ninja - the build; mtools - SD card image; boost/bison/flex/g++ - SDCC sources.
LINUX_PACKAGES="(Debian/Ubuntu) build-essential cmake ninja-build nodejs mtools libboost-dev bison flex texinfo zlib1g-dev git"
# OpenXcom version the converter output is verified against (project_docs/01_environment.md)
OPENXCOM_URL=https://github.com/OpenXcom/OpenXcom.git
OPENXCOM_COMMIT=4a4bae5
OPENXCOM_DIR="$ROOT/REF/OpenXcom"

if [ "$OS" = Darwin ]; then
    JOBS=$(sysctl -n hw.ncpu)
    brew install powershell node cmake ninja mtools boost bison flex
    # Homebrew bison/flex: the macOS ones are too old. Only boost from Homebrew on the
    # include path - the whole /opt/homebrew/include drags isl/gmp into sdcpp and breaks it.
    BREW=$(brew --prefix)
    PATH="$BREW/opt/bison/bin:$BREW/opt/flex/bin:$PATH"
    export PATH
    SDCC_CPPFLAGS="-I$BREW/opt/boost/include"
    sha256() { shasum -a 256 -c -; }
else
    JOBS=$(nproc)
    for t in cc c++ make bison flex node cmake ninja mformat pwsh git; do
        command -v "$t" > /dev/null || { echo "missing: $t - install $LINUX_PACKAGES, PowerShell"; exit 1; }
    done
    SDCC_CPPFLAGS=""
    sha256() { sha256sum -c -; }
fi

if [ ! -d "$OPENXCOM_DIR/bin/standard" ]; then
    git clone -q "$OPENXCOM_URL" "$OPENXCOM_DIR"
    git -C "$OPENXCOM_DIR" checkout -q "$OPENXCOM_COMMIT"
fi

if [ -x "$PREFIX/bin/sdcc" ] && "$PREFIX/bin/sdcc" --version | grep -q "$SDCC_VERSION"; then
    echo "SDCC $SDCC_VERSION already in $PREFIX"
    exit 0
fi

mkdir -p "$TOOLCHAIN/src"
cd "$TOOLCHAIN/src"
TARBALL="sdcc-src-$SDCC_VERSION.tar.bz2"
[ -f "$TARBALL" ] || curl -fsSL -o "$TARBALL" "$SDCC_URL"
echo "$SDCC_SHA256  $TARBALL" | sha256
rm -rf "sdcc-$SDCC_VERSION"
tar xjf "$TARBALL"
cd "sdcc-$SDCC_VERSION"

DISABLE=""
for p in mcs51 z180 r2k r2ka r3ka r4k r5k r6k tlcs90 ez80 z80n r800 ds390 ds400 \
         pic14 pic16 hc08 s08 stm8 pdk13 pdk14 pdk15 pdk16 mos6502 mos65c02 f8 f8l sm83; do
    DISABLE="$DISABLE --disable-$p-port"
done
# shellcheck disable=SC2086
./configure --prefix="$PREFIX" $DISABLE --disable-ucsim --disable-sdcdb \
    --disable-non-free --disable-doc --without-ccache \
    CPPFLAGS="$SDCC_CPPFLAGS" > ../configure.log 2>&1
make -j"$JOBS" > ../make.log 2>&1 || { tail -40 ../make.log; exit 1; }
make install > ../install.log 2>&1
"$PREFIX/bin/sdcc" --version | head -1
