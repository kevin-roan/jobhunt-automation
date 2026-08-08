################################################################################
# Dependencies — installed once and reused by the build and runtime stages.
################################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 falls back to compiling from source when no prebuild matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm install --include=dev

################################################################################
# Build — compile the shared contracts, the API and the dashboard.
################################################################################
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

################################################################################
# Resume fonts — the four families deedy-resume-openfont.cls names by filename.
#
# Those .otf files ship in Debian's `texlive-fonts-extra`, which installs 1.4 GB
# to deliver the ~21 MB this class actually loads. So the package is downloaded
# here, the four font directories are unpacked, and everything else is thrown
# away with the stage. Only the fonts cross into the runtime image.
#
# Build with --build-arg WITH_RESUME_FONTS=0 to skip the ~508 MB download. The
# class then falls back to Latin Modern (see the \IfFontExistsTF branch in
# deedy-resume-openfont.cls): resumes still compile, they just look different.
################################################################################
FROM debian:bookworm-slim AS texfonts
ARG WITH_RESUME_FONTS=1
WORKDIR /tmp/fontsrc
RUN set -eux; \
    mkdir -p /fonts; \
    touch /fonts/.keep; \
    if [ "$WITH_RESUME_FONTS" = "1" ]; then \
      apt-get update; \
      apt-get download texlive-fonts-extra; \
      mkdir -p unpacked; \
      dpkg-deb --fsys-tarfile texlive-fonts-extra_*.deb \
        | tar -x -C unpacked \
            ./usr/share/texlive/texmf-dist/fonts/opentype/impallari/raleway \
            ./usr/share/texlive/texmf-dist/fonts/opentype/public/fira \
            ./usr/share/texlive/texmf-dist/fonts/opentype/public/ebgaramond \
            ./usr/share/texlive/texmf-dist/fonts/opentype/adobe/sourcesanspro; \
      cp -r unpacked/usr/share/texlive/texmf-dist/fonts/opentype/. /fonts/; \
    fi; \
    rm -rf /tmp/fontsrc /var/lib/apt/lists/*

################################################################################
# Runtime — TeX, the LaTeX sandbox, Playwright browsers and the compiled app.
################################################################################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# HOST is set explicitly because the application itself defaults to 127.0.0.1
# (apps/api/src/config/env.ts). That default is right for a bare-metal install —
# the API is unauthenticated — but a container that binds loopback publishes
# nothing, because here the boundary is Docker's published port.
# DISPLAY is set unconditionally because docker/entrypoint.sh brings up an Xvfb
# server on it before exec'ing the app, and BrowserManager.displayAvailable()
# reads exactly this variable to decide whether attended mode can work. Run with
# VIRTUAL_DISPLAY=0 to skip the virtual desktop; the entrypoint then unsets
# DISPLAY so the app correctly reports that no screen exists.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIR=/app/apps/api/public \
    HOST=0.0.0.0 \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    VIRTUAL_DISPLAY=1 \
    DISPLAY=:99 \
    DISPLAY_NUM=99 \
    SCREEN_GEOMETRY=1920x1080x24 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fonts-liberation tini curl bash \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Virtual desktop for attended browsing.
#
# The point of attended mode is that the user signs in to LinkedIn and Indeed
# themselves, in a real window, once — no cookies exported, no tokens pasted.
# That needs a screen, and a container has none, so one is supplied here:
# Xvfb renders to memory, fluxbox makes the window manageable (focus, resize,
# modal dialogs), x11vnc exports the display on container-loopback only, and
# noVNC/websockify serve it over HTTP so the dashboard can embed it directly.
#
# x11-utils is only for xdpyinfo, which the entrypoint uses to wait until the X
# server is actually accepting connections before launching the app.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb \
      x11vnc \
      fluxbox \
      novnc \
      websockify \
      x11-utils \
      xauth \
 && rm -rf /var/lib/apt/lists/* \
 # X servers refuse to start without this directory; it does not exist in a
 # slim base image because nothing else there uses X.
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# ---------------------------------------------------------------------------
# LaTeX resume rendering.
#
# Engine: the resume class uses fontspec, so it needs XeLaTeX — pdflatex cannot
# build it. latexmk + xelatex is the first entry in the engine order that
# LatexService.engine() probes. Without any engine the API still answers, but
# every compile returns "No LaTeX engine is installed" and only the .tex is kept.
#
# Sandbox: bubblewrap is the control that actually contains the TeX engine.
# LatexService probes for `bwrap` at startup and falls back to the regex denylist
# alone — over a Turing-complete language — when it is missing. It needs
# unprivileged user namespaces, which Docker blocks by default; see the
# security_opt entries in docker-compose.yml and docs/deployment.md.
#
# The package set is deliberately narrow. Debian pulls texlive-latex-base,
# texlive-latex-recommended and texlive-latex-extra in behind texlive-xetex,
# which together cover every package the class requires: geometry, xcolor,
# hyperref, titlesec, textpos, isodate, enumitem, microtype, fontspec, textcomp,
# tabularx, longtable and keyval. texlive-lang-english supplies babel's
# UKenglish, texlive-fonts-recommended supplies the Latin Modern OTFs used as the
# font fallback. Documentation and sources are dropped afterwards; they are
# roughly half of what apt installs and nothing reads them here.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-xetex \
      texlive-latex-recommended \
      texlive-latex-extra \
      texlive-fonts-recommended \
      texlive-lang-english \
      latexmk \
      bubblewrap \
 && rm -rf /usr/share/texlive/texmf-dist/doc \
           /usr/share/texlive/texmf-dist/source \
           /usr/share/texmf/doc \
           /var/lib/apt/lists/*

# The class loads faces by file name rather than family name, because family
# lookup goes through fontconfig and that is frequently absent in a container.
# A TEXMF tree is therefore the right home for them, not /usr/share/fonts.
COPY --from=texfonts /fonts/ /usr/local/share/texmf/fonts/opentype/
RUN mktexlsr

# Runtime dependency tree (dev packages pruned) and the compiled output.
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/api/public ./apps/api/public
# The resume class, template and MACROS.md. LatexService.assetsDir() resolves
# this relative to its own dist location and throws if it is absent, so without
# it the resume endpoints fail outright rather than degrading.
COPY --from=build /app/apps/api/assets ./apps/api/assets

# Install the browser builds matching the Playwright version in node_modules.
# Both engines are installed because settings.browser.engine accepts chromium,
# chrome and firefox; they are most of the image's size after TeX.
RUN npx --yes playwright install --with-deps chromium firefox \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/*

# The supervisor that starts the virtual desktop before the app. Copied late so
# editing it does not invalidate the TeX and Playwright layers above.
COPY docker/entrypoint.sh /usr/local/bin/deedy-entrypoint.sh
RUN chmod 755 /usr/local/bin/deedy-entrypoint.sh

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
# 8080 dashboard + API. 6080 noVNC, which grants full control of a browser
# holding the user's live logins — docker-compose.yml publishes it on 127.0.0.1
# only, and it should never be exposed beyond this host.
EXPOSE 8080 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health/live || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/deedy-entrypoint.sh"]
CMD ["node", "apps/api/dist/index.js"]
