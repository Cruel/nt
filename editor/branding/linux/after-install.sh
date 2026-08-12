#!/bin/bash

install_alternative() {
    local name="$1"
    local target="$2"

    if type update-alternatives >/dev/null 2>&1; then
        if [ -e "/usr/bin/$name" ] || [ -L "/usr/bin/$name" ]; then
            if [ ! -L "/usr/bin/$name" ] || [ "$(readlink "/usr/bin/$name")" != "/etc/alternatives/$name" ]; then
                echo "Leaving existing unmanaged /usr/bin/$name unchanged"
                return 0
            fi
        fi
        update-alternatives --install "/usr/bin/$name" "$name" "$target" 100
    elif [ ! -e "/usr/bin/$name" ] && [ ! -L "/usr/bin/$name" ]; then
        ln -sf "$target" "/usr/bin/$name"
    else
        echo "Leaving existing unmanaged /usr/bin/$name unchanged"
    fi
}

install_alternative '${executable}' '/opt/${sanitizedProductName}/${executable}'
install_alternative 'noveltea' '/opt/${sanitizedProductName}/resources/bin/noveltea'

# Check if user namespaces are supported by the kernel and working with a quick test.
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install the Ubuntu 24+ AppArmor profile when the host parser accepts it. Older supported hosts
# skip this because their AppArmor ABI cannot load the generated profile.
if apparmor_status --enabled > /dev/null 2>&1; then
    APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
    APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
    if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
        cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
        APPARMOR_STATE_ROOT='/var/lib/${sanitizedProductName}'
        mkdir -p "$APPARMOR_STATE_ROOT"
        sha256sum "$APPARMOR_PROFILE_TARGET" | cut -d ' ' -f 1 > "$APPARMOR_STATE_ROOT/apparmor-profile.sha256"
        if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
            apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
        fi
    else
        echo "Skipping the NovelTea Editor AppArmor profile because this host does not support its ABI"
    fi
fi
