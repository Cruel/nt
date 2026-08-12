#!/bin/bash
set -euo pipefail

pointer=editor/out/electron-builder/latest-artifact.json
output_root=$(node -e "const p=require('./$pointer'); process.stdout.write(p.outputRoot)")
deb_name=$(node -e "const p=require('./$pointer'); process.stdout.write(p.artifacts.find(x=>x.fileName.endsWith('.deb')).fileName)")
rpm_name=$(node -e "const p=require('./$pointer'); process.stdout.write(p.artifacts.find(x=>x.fileName.endsWith('.rpm')).fileName)")
deb="$output_root/$deb_name"
rpm="$output_root/$rpm_name"
package=$(dpkg-deb -f "$deb" Package)

if [ -e /usr/bin/noveltea ] || [ -L /usr/bin/noveltea ]; then
    echo '/usr/bin/noveltea unexpectedly exists before installer smoke' >&2
    exit 1
fi

conflict=/tmp/noveltea-existing
printf '#!/bin/sh\nexit 0\n' > "$conflict"
chmod 0755 "$conflict"
sudo ln -s "$conflict" /usr/bin/noveltea
sudo apt-get install -y "$deb"
test "$(readlink /usr/bin/noveltea)" = "$conflict"
sudo apt-get remove -y "$package"
test "$(readlink /usr/bin/noveltea)" = "$conflict"
sudo rm -f /usr/bin/noveltea "$conflict"

sudo apt-get install -y "$deb"
noveltea --json --version | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);if(!p.success||p.exitCode!==0)process.exit(1)})"
sudo apt-get remove -y "$package"
test ! -e /usr/bin/noveltea

docker run --rm -v "$rpm:/tmp/noveltea-editor.rpm:ro" fedora:latest bash -lc '
  set -euo pipefail
  dnf install -y /tmp/noveltea-editor.rpm
  noveltea --json --version | grep -q "\"success\":true"
  dnf remove -y noveltea-editor
  test ! -e /usr/bin/noveltea
'
