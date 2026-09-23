#!/bin/sh
# Installs the official Go toolchain into /usr/local/go for CI jobs whose image
# is Node (Debian), so one job can run Node, Go and Python together. The
# archive is checked against the SHA-256 go.dev publishes before it is
# unpacked. Add a version here, with its checksum, before a job asks for it.
set -eu

version="${1:?usage: scripts/install-go.sh <go version, e.g. 1.26.4>}"

case "$version" in
  1.26.4) sha256=1153d3d50e0ac764b447adfe05c2bcf08e889d42a02e0fe0259bd47f6733ad7f ;;
  *)
    echo "install-go: no pinned checksum for Go $version" >&2
    exit 1
    ;;
esac

archive="go${version}.linux-amd64.tar.gz"
curl -fsSLo "/tmp/$archive" "https://go.dev/dl/$archive"
echo "$sha256  /tmp/$archive" | sha256sum -c -
rm -rf /usr/local/go
tar -C /usr/local -xzf "/tmp/$archive"
rm "/tmp/$archive"
/usr/local/go/bin/go version
