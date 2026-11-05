# The released QAuth server image with this plugin added the way an operator
# adds it (QAuth's docs: operate/images, "Add a plugin to the image"). The
# plugin is the tarball `npm pack` made of this checkout, the same file npm
# would publish; run.sh puts it at .work/plugin.tgz.
#
# The plugin is installed nested, so it brings its own copy of the plugin SDK,
# without its peer dependencies, so it uses the server's zod, and without
# install scripts. An operator installs a released version from a lockfile
# with `npm ci`; this test installs the tarball it has just packed.
ARG QAUTH_IMAGE=ghcr.io/qauth-labs/qauth/auth-server:0.2.0-rc.1@sha256:a4b199c5b1e896346d09c348f0a6cb055ab4f64bf82e0654740b0aa2631e5e8c

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS plugin
WORKDIR /plugin
COPY .work/plugin.tgz /tmp/plugin.tgz
RUN npm init --yes > /dev/null \
 && npm install --omit=dev --omit=peer --install-strategy=nested --ignore-scripts /tmp/plugin.tgz

FROM ${QAUTH_IMAGE}
COPY --from=plugin --chown=nodejs:nodejs \
  /plugin/node_modules/@qauth-labs/plugin-github \
  /app/node_modules/@qauth-labs/plugin-github
