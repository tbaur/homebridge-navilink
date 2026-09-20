# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please). Versions, `CHANGELOG.md`, git tags, GitHub Releases and `npm publish` all come from commit messages. None of them are edited or run by hand.

## Shipping a release

1. **Branch and commit.** Include the `dist/` build with the source. CI fails if the two have drifted.
2. **Open a PR with a Conventional Commit title.** The title picks the next version. See [Version bumps](#version-bumps).
3. **Let the checks pass, then squash-merge to `main`.** The PR title becomes the commit release-please reads.
4. **release-please opens a Release PR** titled `chore(main): release X.Y.Z`. Several merged PRs are batched into one.
5. **Read its diff.** It must change exactly four files. See [Read the Release PR diff](#read-the-release-pr-diff).
6. **Approve its checks.** They are held and will not run on their own. See [Approve the Release PR checks](#approve-the-release-pr-checks).
7. **Merge it.** `release.yml` then tags `vX.Y.Z`, publishes the GitHub Release, and runs the `publish` job (install → build → lint → test → `npm publish --dry-run` → `npm publish` with provenance).
8. **Confirm it landed:** `npm view homebridge-navilink version`. The registry can lag a few minutes behind a successful publish.

## Homebridge verified `/check`

The [homebridge/plugins](https://github.com/homebridge/plugins) `/check` installs the **published** package. It fails until all of these are true for the same version:

- The package is on npm and is not deprecated
- The GitHub repository is public, not archived, and has issues enabled
- That version has a GitHub Release
- `package.json` on the default branch matches the npm version

release-please does the last two on every release after the first. For the first `/check`, publish `0.1.0` and create the `v0.1.0` GitHub Release before opening the verification issue.

## Before a release

The test suite never touches the network, so it cannot tell you the cloud still behaves the way this plugin assumes. Against a real account, read-only:

```bash
npm run build
node scripts/smoke.js
node scripts/pseudonymise.js --in tests/fixtures --check
```

`smoke.js` exercises the whole path end to end: sign-in, the AWS credential exchange, the SigV4 URL, the MQTT handshake, identity uniqueness, the subscription and both read commands. An interface nobody publishes can change without warning. This is the only check that would notice. `pseudonymise.js --check` confirms that nothing identifying has crept into the committed fixtures. Use `node scripts/capture-fixture.js --redact` when filing a bug report, not as the pre-release recipe.

`CHANGELOG.md` stays as the release-please stub until the first Release PR lands. Do not edit it by hand.

## Approve the Release PR checks

The Release PR is authored by `github-actions[bot]`, because `release.yml` passes `github.token` to release-please. GitHub creates its Tests and OSV-Scanner runs but holds them until a user with write access approves.

**Open the Release PR's Checks tab and click "Approve and run" before merging.**

- There is no CLI for this. `POST /actions/runs/{run_id}/approve` is documented for forks from first-time contributors and does not cover this gate.
- The approval does not stick. It is needed on every release, and again whenever release-please updates an open Release PR.
- **Merging without approving turns the runs red.** They finalise as `failure` with zero jobs and no logs. That means nobody approved them, not that anything broke.

The only way to remove this step is to author the Release PR as a different identity, which needs a GitHub App or a PAT. Neither is set up here, and the click is cheaper.

## Read the Release PR diff

A healthy Release PR changes exactly four files: `package.json`, `package-lock.json`, `CHANGELOG.md` and `.release-please-manifest.json`. Every change is a version number or changelog text.

**Anything else means the release branch was cut before some of the commits it is releasing, and merging it will *undo* them.** Close the Release PR, delete its branch (`release-please--branches--main--components--homebridge-navilink`), and let the next push to `main` open a fresh one.

## Version bumps

| PR title prefix | Example | Version bump |
|---|---|---|
| `fix:` | `fix: treat a zero outdoor reading as no sensor` | patch (1.0.0 → 1.0.1) |
| `feat:` | `feat: expose hot water flow as a sensor` | minor (1.0.0 → 1.1.0) |
| `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer | `feat!: drop Node 22` | major (1.0.0 → 2.0.0) |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | `docs: fix typo` | no release |

A `Release-As: X.Y.Z` footer on the squash commit forces that version. That is how 1.0.0 is cut. After 1.0.0 the usual `feat` / major rules apply. The `bump-patch-for-minor-pre-major` and `bump-minor-pre-major` flags in `release-please-config.json` only affect a 0.x line.

Dependabot titles runtime bumps `fix:` and development bumps `chore:` (see `.github/dependabot.yml`), so a dependency users install cuts a patch release on its own while a test dependency waits for the next release to carry it.

## Setup that is already done

- **Publishing** uses npm Trusted Publishing (OIDC), so there is no `NPM_TOKEN`. The package is linked on npmjs.com to this repo's `release.yml`, under Settings → Trusted Publisher. This is not reconfigured per release.
- **Actions may create pull requests** (Settings → Actions → General → Workflow permissions). Without it, release-please writes the branch but cannot open the PR.
- **`main` is protected:** a PR is required (0 approvals), force-pushes and deletions are blocked, and no status check is a hard gate. Tests and OSV run on the PR, not again on merge. Release is the only workflow that starts on a push to `main`. The `publish` job re-runs build, lint and test before `npm publish`, so nothing ships untested.

## Notes

- **Version source of truth** is `.release-please-manifest.json`. The `package.json` version belongs to release-please and is never hand-edited.
- **Behaviour** is configured in `release-please-config.json`.
- **A change to a control command deserves a changelog note.** That changes what the plugin will actually do to somebody's boiler. Say so in the PR description.
- **Accessory-affecting releases** deserve a note too. Anything that changes an accessory's identity re-creates it in HomeKit and costs the user its room and automations. Prefer adopting, not re-keying, and say so in the PR when it cannot be avoided.

## Manual fallback

Rarely needed, and it bypasses CI provenance and manifest syncing. If unavoidable:

```bash
npm run clean && npm run build && npm run lint && npm test
npm publish --dry-run   # verify contents
npm publish             # requires npm login + OTP
```
