# Changelog

Releases are tracked on GitHub, not hand-maintained here. Each release has a
version tag you can pull, with auto-generated notes (the merged PRs) on the
release page:

- **All releases:** <https://github.com/f3nici/carelane/releases>
- **Latest:** <https://github.com/f3nici/carelane/releases/latest>

Pull a specific version by its tag — e.g.:

```bash
git checkout 0.6.3                      # from source
docker pull <your-dockerhub-user>/carelane:0.6.3   # or the published image
```

Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
tags are the bare version number (e.g. `0.6.3`, no `v` prefix).
