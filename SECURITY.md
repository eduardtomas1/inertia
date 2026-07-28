# Security policy

## Supported versions

Inertia is beta software. Security fixes are provided for the latest tagged
release only. Development snapshots and older releases are not supported.

## Reporting a vulnerability

Do not report security vulnerabilities in a public issue, pull request,
discussion, or log attachment.

Use GitHub's private vulnerability reporting form:

https://github.com/eduardtomas1/inertia/security/advisories/new

If GitHub does not offer the private form, do not substitute a public report.
Repository maintainers must enable private vulnerability reporting before
accepting reports.

Include only the minimum information needed to investigate:

- the affected Inertia version, operating system, and provider or harness;
- the security impact and the boundary that was crossed;
- a minimal reproduction using a throwaway repository and test account;
- a redacted error excerpt, if it is necessary to explain the behavior.

Never include credentials, tokens, private prompts, proprietary source code,
repository names, account identifiers, full local paths, or unredacted
diagnostic bundles. Maintainers may request additional information through the
private advisory.

Reports involving Inertia's privileged Electron IPC or runtime boundary,
credential storage, repository containment or reversal, provider adapters, and
release or update packaging are in scope. Report a vulnerability in an
upstream provider, CLI, SDK, Electron, or other dependency to that project as
well; notify Inertia privately when its integration increases the impact.

Maintainers will acknowledge and triage reports on a best-effort basis. Do not
access other people's data, disrupt services, retain sensitive data, or use
destructive tests. Good-faith research that follows these rules will not be
treated as malicious.

## Release verification

Release assets include SHA-256 checksums and GitHub build-provenance
attestations. Code signing depends on the credentials available for that
release: macOS artifacts may use ad-hoc signing, and Windows artifacts may be
unsigned. See [docs/RELEASING.md](docs/RELEASING.md) for the exact release
process and verification commands.
