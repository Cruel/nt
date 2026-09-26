FROM quay.io/pypa/manylinux_2_28_x86_64@sha256:2394d7b597cb186bc1e9da06543ec1e2a97533a2e1a5ce739c65e755571de7bd

RUN dnf -y install \
      autoconf-archive \
      ccache \
      curl \
      flex \
      libtool \
      libtool-ltdl-devel \
      libXcursor-devel \
      libXi-devel \
      libXinerama-devel \
      libXrandr-devel \
      libXtst-devel \
      libxkbcommon-devel \
      mesa-libEGL-devel \
      ninja-build \
      tar \
      unzip \
      wayland-devel \
      wayland-protocols-devel \
      zip \
    && dnf clean all

# The base image supplies glibc 2.28, GCC 14, CMake, Git, pkg-config, and the
# core X11/OpenGL development headers. Release CI bind-mounts the checkout and
# keeps vcpkg/ccache state outside the image so the ABI environment stays fixed.
