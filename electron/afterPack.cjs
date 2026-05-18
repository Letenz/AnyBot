const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const resourcesDir = context.packager.platform.name === "mac"
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
        "Resources",
      )
    : path.join(context.appOutDir, "resources");

  const nodeDir = path.join(resourcesDir, "node");
  fs.mkdirSync(nodeDir, { recursive: true });

  const target = path.join(nodeDir, process.platform === "win32" ? "node.exe" : "node");
  fs.copyFileSync(process.execPath, target);

  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o755);
  }

  console.log(`[afterPack] bundled Node runtime: ${target}`);
};
