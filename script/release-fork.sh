#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Create a GitHub release on a fork with built OpenCode CLI assets.

Usage:
  ./script/release-fork.sh --version <version> [options]

Required:
  --version <version>       Version without or with leading v (ex: 1.1.63-swe1 or v1.1.63-swe1)

Options:
  --repo <owner/repo>       GitHub repo for release (default: rasdani/opencode)
  --all-targets             Build all targets (default: single target for current platform)
  --draft-only              Keep release as draft (do not publish)
  --notes <text>            Release notes text (default: Fork release for swe-training)
  --notes-file <file>       Release notes file (mutually exclusive with --notes)
  -h, --help                Show this help

Examples:
  ./script/release-fork.sh --version 1.1.63-swe1
  ./script/release-fork.sh --version v1.1.63-swe1 --repo rasdani/opencode --all-targets --draft-only
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

VERSION=""
REPO="rasdani/opencode"
ALL_TARGETS="false"
DRAFT_ONLY="false"
NOTES_TEXT="Fork release for swe-training"
NOTES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --all-targets)
      ALL_TARGETS="true"
      shift
      ;;
    --draft-only)
      DRAFT_ONLY="true"
      shift
      ;;
    --notes)
      NOTES_TEXT="${2:-}"
      shift 2
      ;;
    --notes-file)
      NOTES_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "--version is required" >&2
  usage
  exit 1
fi

if [[ -n "$NOTES_FILE" && -n "$NOTES_TEXT" ]]; then
  echo "--notes and --notes-file cannot be used together" >&2
  exit 1
fi

if [[ -n "$NOTES_FILE" && ! -f "$NOTES_FILE" ]]; then
  echo "Notes file not found: $NOTES_FILE" >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repo: $ROOT" >&2
  exit 1
fi

require_cmd git
require_cmd bun
require_cmd gh
require_cmd tar
require_cmd zip

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

VERSION="${VERSION#v}"
TAG="v$VERSION"

echo "Repo: $REPO"
echo "Tag:  $TAG"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Local tag already exists: $TAG"
else
  git tag -a "$TAG" -m "fork release $TAG"
  echo "Created local tag: $TAG"
fi

if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Remote tag already exists on origin: $TAG"
else
  git push origin "$TAG"
  echo "Pushed tag to origin: $TAG"
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release already exists on $REPO: $TAG"
else
  if [[ -n "$NOTES_FILE" ]]; then
    gh release create "$TAG" \
      --repo "$REPO" \
      --draft \
      --title "$TAG" \
      --notes-file "$NOTES_FILE"
  else
    gh release create "$TAG" \
      --repo "$REPO" \
      --draft \
      --title "$TAG" \
      --notes "$NOTES_TEXT"
  fi
  echo "Created draft release: $REPO $TAG"
fi

BUILD_ARGS=(--skip-install)
if [[ "$ALL_TARGETS" != "true" ]]; then
  BUILD_ARGS+=(--single)
fi

echo "Building artifacts..."
(
  cd packages/opencode
  OPENCODE_VERSION="$VERSION" ./script/build.ts "${BUILD_ARGS[@]}"
)

DIST_DIR="packages/opencode/dist"
rm -f "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.zip

shopt -s nullglob
dirs=("$DIST_DIR"/opencode-*)
if [[ ${#dirs[@]} -eq 0 ]]; then
  echo "No build output directories found under $DIST_DIR" >&2
  exit 1
fi

echo "Packaging release archives..."
for dir in "${dirs[@]}"; do
  [[ -d "$dir/bin" ]] || continue
  name="$(basename "$dir")"
  if [[ "$name" == *linux* ]]; then
    (
      cd "$dir/bin"
      tar -czf "../../$name.tar.gz" .
    )
  else
    (
      cd "$dir/bin"
      zip -qr "../../$name.zip" .
    )
  fi
done

assets=( "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.zip )
if [[ ${#assets[@]} -eq 0 ]]; then
  echo "No archives found to upload in $DIST_DIR" >&2
  exit 1
fi

echo "Uploading assets..."
gh release upload "$TAG" --repo "$REPO" "${assets[@]}" --clobber

if [[ "$DRAFT_ONLY" == "true" ]]; then
  echo "Release kept as draft: https://github.com/$REPO/releases/tag/$TAG"
  exit 0
fi

echo "Publishing release..."
gh release edit "$TAG" --repo "$REPO" --draft=false
echo "Published: https://github.com/$REPO/releases/tag/$TAG"
