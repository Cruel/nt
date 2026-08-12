#!/bin/bash

remove_alternative() {
    local name="$1"
    local target="$2"

    if type update-alternatives >/dev/null 2>&1; then
        update-alternatives --remove "$name" "$target" || true
    elif [ -L "/usr/bin/$name" ] && [ "$(readlink "/usr/bin/$name")" = "$target" ]; then
        rm -f "/usr/bin/$name"
    fi
}

remove_alternative '${executable}' '/opt/${sanitizedProductName}/${executable}'
remove_alternative 'noveltea' '/opt/${sanitizedProductName}/resources/bin/noveltea'

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'
APPARMOR_STATE_ROOT='/var/lib/${sanitizedProductName}'
APPARMOR_PROFILE_HASH="$APPARMOR_STATE_ROOT/apparmor-profile.sha256"
if [ -f "$APPARMOR_PROFILE_DEST" ] && [ -f "$APPARMOR_PROFILE_HASH" ] && \
    [ "$(sha256sum "$APPARMOR_PROFILE_DEST" | cut -d ' ' -f 1)" = "$(cat "$APPARMOR_PROFILE_HASH")" ]; then
    if apparmor_status --enabled > /dev/null 2>&1; then
        if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
            apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
        fi
    fi
    rm -f "$APPARMOR_PROFILE_DEST"
fi
rm -f "$APPARMOR_PROFILE_HASH"
rmdir "$APPARMOR_STATE_ROOT" 2>/dev/null || true
