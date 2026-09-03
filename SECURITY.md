# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |

## Reporting a Vulnerability

Please report security issues privately to the repository maintainers through GitHub
[private vulnerability reporting](https://github.com/hunterT20/agent-effectiveness-labs/security/advisories/new)
or a direct maintainer contact channel listed in `CONTRIBUTING.md`.

Do not open public issues for undisclosed vulnerabilities.

## Response Targets

- Acknowledgement: within 3 business days
- Initial triage: within 7 business days
- Fix or mitigation plan: severity-dependent, typically within 30 days

## Scope

In scope:

- isolation bypass (hidden grader, artifact, or home directory access)
- secret leakage through reports, logs, or artifacts
- supply-chain issues in published npm packages
- unsafe HTML/script injection in generated reports

Out of scope:

- vulnerabilities in third-party agent CLIs (Cursor, Codex, etc.)
- issues requiring a live paid agent run to reproduce

## Safe Harbor

We support good-faith security research that follows responsible disclosure and avoids
privacy violations, data destruction, or service disruption.
