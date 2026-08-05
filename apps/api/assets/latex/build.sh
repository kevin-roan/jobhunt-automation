#!/usr/bin/env bash
#
# Build a resume .tex -> .pdf, using the same engine order as the API renderer.
# The API compiles resumes in-process; this script is the manual escape hatch
# for editing a .tex by hand or for debugging a failing document.
#
#   ./build.sh [file.tex]    build once (default: resume-template.tex)
#   ./build.sh -o [file]     build, then open the PDF
#   ./build.sh -w [file]     rebuild automatically on every save (needs latexmk)
#   ./build.sh -c            delete build artefacts and exit
#   ./build.sh -v [file]     show the full engine log instead of a summary
#
# The class uses fontspec, so it needs XeLaTeX (or LuaLaTeX) -- pdflatex cannot
# build it. Engines are tried in order: latexmk, xelatex, lualatex, tectonic.

set -euo pipefail

BUILDDIR=".build"

cd "$(dirname "$(readlink -f "$0")")"

OPEN=0; WATCH=0; CLEAN=0; VERBOSE=0
while getopts ":owcvh" opt; do
  case $opt in
    o) OPEN=1 ;;
    w) WATCH=1 ;;
    c) CLEAN=1 ;;
    v) VERBOSE=1 ;;
    h) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    \?) echo "unknown option -$OPTARG (try -h)" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))

SRC="${1:-resume-template.tex}"
JOB="$(basename "${SRC%.*}")"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

if [ "$CLEAN" -eq 1 ]; then
  rm -rf "$BUILDDIR"
  info "removed $BUILDDIR (PDFs kept)"
  exit 0
fi

[ -f "$SRC" ] || die "$SRC not found in $PWD"
[ -f "deedy-resume-openfont.cls" ] || die "deedy-resume-openfont.cls missing; it must sit beside $SRC"

# Build the candidate list in preference order. Every one of these can produce
# the document; the loop below falls through to the next if one is unusable.
ENGINES=()
command -v latexmk  >/dev/null 2>&1 && command -v xelatex >/dev/null 2>&1 && ENGINES+=(latexmk)
command -v xelatex  >/dev/null 2>&1 && ENGINES+=(xelatex)
command -v lualatex >/dev/null 2>&1 && ENGINES+=(lualatex)
command -v tectonic >/dev/null 2>&1 && ENGINES+=(tectonic)
[ -x ./tectonic ] && ENGINES+=(./tectonic)

[ ${#ENGINES[@]} -gt 0 ] || die "no LaTeX engine found. Install one of:
    sudo pacman -S texlive-xetex texlive-latex texlive-latexrecommended \\
                   texlive-latexextra texlive-fontsrecommended texlive-fontsextra
    sudo apt install texlive-xetex texlive-latex-extra texlive-fonts-extra
  or drop a 'tectonic' binary in this folder."

if [ "$WATCH" -eq 1 ]; then
  [[ " ${ENGINES[*]} " == *" latexmk "* ]] || die "-w needs latexmk (sudo pacman -S texlive-binextra)"
  info "watching $SRC -- Ctrl-C to stop"
  exec latexmk -xelatex -pvc -interaction=nonstopmode \
       -jobname="$JOB" -outdir="$BUILDDIR" "$SRC"
fi

mkdir -p "$BUILDDIR"
LOG="$BUILDDIR/build.out"

run_engine() {
  case "$1" in
    latexmk)
      latexmk -xelatex -halt-on-error -interaction=nonstopmode \
              -jobname="$JOB" -outdir="$BUILDDIR" "$SRC" >"$LOG" 2>&1
      ;;
    tectonic|./tectonic)
      # Tectonic always runs to a fixed point, so no repeat pass is needed.
      "$1" -k --outdir "$BUILDDIR" "$SRC" >"$LOG" 2>&1
      ;;
    *)
      # Two passes so any cross-reference settles.
      "$1" -halt-on-error -interaction=nonstopmode -no-shell-escape \
           -jobname="$JOB" -output-directory="$BUILDDIR" "$SRC" >"$LOG" 2>&1 \
      && "$1" -halt-on-error -interaction=nonstopmode -no-shell-escape \
           -jobname="$JOB" -output-directory="$BUILDDIR" "$SRC" >>"$LOG" 2>&1
      ;;
  esac
}

STATUS=1
for candidate in "${ENGINES[@]}"; do
  info "building with ${candidate##*/}"
  set +e; run_engine "$candidate"; STATUS=$?; set -e
  [ "$STATUS" -eq 0 ] && { ENGINE="$candidate"; break; }

  # Translate the two opaque failures a fresh TeX Live install produces.
  if grep -q "can't find the format file" "$LOG" 2>/dev/null; then
    printf '\033[33mwarn:\033[0m %s is installed but has no format file.\n' "${candidate##*/}" >&2
    printf '      fix:  sudo fmtutil-sys --all\n' >&2
  fi
  MISSING=$(grep -oE "File \`[A-Za-z0-9_.-]+' not found" "$LOG" 2>/dev/null \
            | sed -E "s/File \`(.*)' not found/\\1/" | sort -u | tr '\n' ' ')
  if [ -n "$MISSING" ]; then
    printf '\033[33mwarn:\033[0m %s cannot find: %s\n' "${candidate##*/}" "$MISSING" >&2
    printf '      the LaTeX package collections are not installed. fix:\n' >&2
    printf '      sudo pacman -S texlive-latex texlive-latexrecommended texlive-latexextra texlive-binextra\n' >&2
  fi

  printf '\033[33mwarn:\033[0m %s failed, trying next engine\n' "${candidate##*/}" >&2
done

if [ "$VERBOSE" -eq 1 ]; then
  cat "$LOG"
fi

if [ "$STATUS" -ne 0 ]; then
  echo
  grep -iE '^(!|error:)' -A4 "$LOG" | head -40 || true
  echo
  die "build failed -- full log: $LOG"
fi

# Tectonic names its output after the source stem, others after -jobname.
OUT="$BUILDDIR/$JOB.pdf"
[ -f "$OUT" ] || OUT="$BUILDDIR/$(basename "${SRC%.*}").pdf"
[ -f "$OUT" ] || die "engine reported success but produced no PDF -- see $LOG"
cp "$OUT" "$JOB.pdf"

PAGES="?"
if command -v pdfinfo >/dev/null 2>&1; then
  PAGES=$(pdfinfo "$JOB.pdf" | awk '/^Pages:/{print $2}')
fi
WARNS=$(grep -ciE 'overfull|underfull|latex warning' "$LOG" || true)

printf '\033[32m==>\033[0m %s  (%s pages, %s layout warnings)\n' "$JOB.pdf" "$PAGES" "$WARNS"
[ "$WARNS" -gt 0 ] && echo "    detail: grep -iE 'overfull|underfull' $LOG"

if [ "$OPEN" -eq 1 ]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$JOB.pdf" >/dev/null 2>&1 &
  else
    echo "    (no xdg-open; open $PWD/$JOB.pdf manually)"
  fi
fi

exit 0
