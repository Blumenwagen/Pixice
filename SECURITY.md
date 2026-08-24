# Security policy

## Supported version

Security fixes currently target the newest Pixice prerelease only.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the private security advisory form in the repository's Security tab at https://github.com/Blumenwagen/Pixice/security/advisories/new.

Include the affected version and platform, the required conditions, impact, reproduction steps, and any proposed fix. Do not include real credentials or unrelated private data. Please allow time to reproduce and patch the issue before public disclosure.

Pixice can execute agent tools and workflows against local projects. A prompt injection or untrusted workflow output is security-relevant when it crosses the permission boundary or performs an action the user did not authorize. Content that only causes an action already covered by an explicit user permission is not automatically a vulnerability.
