const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const env = {
  ...process.env,
  ELECTRON_CACHE: process.env.ELECTRON_CACHE || path.join(root, ".electron-cache"),
  ELECTRON_BUILDER_CACHE:
    process.env.ELECTRON_BUILDER_CACHE || path.join(root, ".electron-builder-cache"),
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
};

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runNode(path.join(root, "node_modules", "vite", "bin", "vite.js"), ["build"]);
runNode(path.join(root, "node_modules", "electron-builder", "cli.js"), ["--win", "nsis", "--publish", "never"]);
