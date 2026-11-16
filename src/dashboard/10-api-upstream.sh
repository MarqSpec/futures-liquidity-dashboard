#!/bin/sh
# Substitute only API_UPSTREAM. The explicit list keeps nginx's $host, $uri and $http_upgrade
# as nginx variables. This file is not under /etc/nginx/templates, so the image entrypoint's
# own envsubst pass does not rewrite it with every variable in the environment.
set -eu
: "${API_UPSTREAM:=http://futuresliquiditydashboard.api:8080}"
envsubst '${API_UPSTREAM}' < /etc/nginx/default.conf.template > /etc/nginx/conf.d/default.conf
