# Caddy with the rate-limit module: stock Caddy has no rate limiter. Built on
# the demo VM from the release tag's checkout; not a product image.
FROM caddy:2.11.7-builder-alpine@sha256:80331d37e7d4d230f186f2707079e279f32552924f101ee659e8cae9f9877c26 AS build
RUN xcaddy build v2.11.7 \
    --with github.com/mholt/caddy-ratelimit@v0.1.1-0.20260612195517-5625512f24f6

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
