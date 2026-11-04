# Vendored source

Source: https://github.com/cinob/dsh-web-search-multi, version 0.1.0, commit 9821080e36dbd81dd75fd582fb687944244ec293, by cinob, MIT (see LICENSE).

The installer retains the upstream runtime, client, source, and bundle patch. Clone metadata, tests, lockfile, and the machine-local build script are omitted; the corresponding developer scripts were removed from package.json. The server entrypoints and source are patched to resolve schemastery through the version-guarded packaged rc.5 host loader in lib/host-deps.js. The client remains upstream. The installer overrides the bundle's search defaults in its later integrations patch.
