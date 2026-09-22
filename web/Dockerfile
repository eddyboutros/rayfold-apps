# One image recipe for every front end; `--build-arg APP=documents-ui` picks which. Each is built from its own
# lockfile and served by nginx as static files, with the gateway in front deciding which path reaches it.
#
# A remote is built with its path as base href, so the chunks its remoteEntry.json names resolve under
# /remotes/<app>/ wherever the page that loads it lives.

FROM node:24-alpine AS build
ARG APP
ARG BASE_HREF=/
WORKDIR /app
COPY design ./design
COPY ${APP}/package.json ${APP}/package-lock.json ./${APP}/
RUN cd ${APP} && npm ci
COPY ${APP} ./${APP}
RUN cd ${APP} && npx ng build --base-href ${BASE_HREF}

FROM nginx:1.27-alpine
ARG APP
COPY nginx.static.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/${APP}/dist/${APP}/browser /usr/share/nginx/html
EXPOSE 80
