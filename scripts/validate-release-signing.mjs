import signingPolicy from "./release-signing-policy.cjs";

const platform = process.argv[2] ?? "";
signingPolicy.requirePublicReleaseSigningSet(platform);
console.log(`Complete ${platform} public-release signing configuration verified.`);
