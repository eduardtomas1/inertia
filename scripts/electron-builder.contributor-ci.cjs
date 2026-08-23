const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  appId: `${packageJson.build.appId}.contributor-ci`,
  // Contributor packages exercise native packaging without acquiring the
  // stable release identity or generating metadata for the stable update feed.
  publish: [],
  extraMetadata: {
    ...packageJson.build.extraMetadata,
    inertiaUpdateCapability: {
      delivery: "manual",
      reason: "contributor-ci-build",
    },
  },
};
