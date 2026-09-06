// M0 stub: `just build-wasm` produces no web assets to serve yet. This
// creates the dist directory pages.yml deploys so the workflow has
// something to upload.
await Deno.mkdir("web/dist", { recursive: true });
await Deno.writeTextFile("web/dist/index.html", "polyvisor — M0");
