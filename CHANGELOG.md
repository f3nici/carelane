# Changelog

Releases are tracked on GitHub, not hand-maintained here. Each release has a
version tag you can pull, with auto-generated notes (the merged PRs) on the
release page:

- **All releases:** <https://github.com/f3nici/carelane/releases>
- **Latest:** <https://github.com/f3nici/carelane/releases/latest>

Pull a specific version by its tag — e.g.:

```bash
git checkout 0.5.2                      # from source
docker pull <your-dockerhub-user>/carelane:0.5.2   # or the published image
```

Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
tags are the bare version number (e.g. `0.5.2`, no `v` prefix).

## Unreleased

Changes merged to `main` but not yet cut into a release.

### Added
- Housekeeping for self-hosters: `LICENSE` (MIT with the Commons Clause —
  source-available; free to use, modify, fork and self-host, including for your
  own paid practice, but no reselling or hosting it as a service for others),
  this `SECURITY.md` disclosure policy, and Dependabot configuration for npm,
  GitHub Actions and Docker updates.
- README section documenting the terms of service for every optional outbound
  integration (Anthropic, Hugging Face, Google, Square, Docker Hub).
