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
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIR=/app/apps/api/public \
    HOST=0.0.0.0 \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fonts-liberation tini curl \
 && rm -rf /var/lib/apt/lists/*

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

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health/live || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
