# Contributing to homebridge-navilink

Thank you for your interest in contributing! This guide will help you get started.

## The most useful thing you can contribute

A redacted capture from a family that is not an NCB:

```bash
npm run build
node scripts/capture-fixture.js --redact
```

The [supported devices table](README.md#supported-devices) is confirmed on an NCB-240E. Other families are decoded from the same table the NaviLink app uses. A capture from one of those lets the table say so.

## Getting Started

You need **Node.js 22, 24 or 26** (the version range the plugin declares in `engines`). CI runs the test suite on all three.

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/homebridge-navilink.git
   cd homebridge-navilink
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

## Development Workflow

### Running Tests

```bash
npm test              # Build, then Jest with coverage (NODE_ENV=test)
npm run lint          # Warnings are failures
npm run lint:fix      # Auto-fix style issues
npx tsc --noEmit -p tsconfig.test.json  # src + tests
```

The suite never touches the network. It also refuses to run if `NAVILINK_EMAIL` or `NAVILINK_PASSWORD` is set in your environment, which is there to stop a half-finished test sending your own credentials to Navien.

### Code Style

- Use `const`/`let`, never `var`
- Use async/await over raw Promises
- Add JSDoc comments for public functions
- Comments explain *why*, not *what*
- Follow existing code patterns

### Making Changes

1. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes
3. Add/update tests
4. Ensure all tests pass: `npm test` (coverage must stay >= 80%)
5. Ensure linting passes: `npm run lint`
6. Rebuild and commit the compiled output: `npm run build`, then commit any changes under `dist/`. `dist/` is intentionally tracked in git so installing from a git URL works, and CI fails if it drifts from `src/`.
7. Commit with a descriptive message

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org). PR titles drive automated releases via release-please, so use prefixes like:

- `feat:` - New feature (pre-1.0 this is a patch bump)
- `fix:` - Bug fix
- `docs:` / `test:` / `refactor:` / `chore:` / `ci:` - no release

Example: `feat: expose hot water flow as a sensor`

## Pull Request Process

1. Update documentation if needed
2. Ensure CI passes (build, lint, typecheck, tests, `dist/` in sync)
3. Request review from maintainers

> `CHANGELOG.md` is generated automatically by release-please from your Conventional Commit and PR titles. Do not edit it by hand. See [RELEASING.md](RELEASING.md).

### PR Checklist

- [ ] Tests added/updated
- [ ] Linting passes
- [ ] `dist/` rebuilt and committed (`npm run build`)
- [ ] Documentation updated
- [ ] No credential, MAC address or real account in any committed file
- [ ] Descriptive PR title (Conventional Commits)

## Adding a Capability

New accessories are welcome. See [DEVELOPMENT.md](DEVELOPMENT.md#adding-a-capability) for the mechanics and [docs/PROTOCOL.md](docs/PROTOCOL.md) for what is already mapped. Four things are worth knowing before you start:

- **This drives a gas appliance.** A guessed command code is not a bug that shows up as a wrong colour in the UI. Record anything new in PROTOCOL.md and pin a fixture.
- **The test is whether HomeKit expresses it well, not whether the protocol offers it.** A tile, a scene, an automation trigger or a spoken command is a good fit. A weekly schedule is not: HomeKit has no vocabulary for one, and a second scheduler that disagrees with the NaviLink app is worse than none. A PR in that direction will be declined on those grounds, not on quality. Please open an issue first if you are unsure which side of the line something falls on.
- **Never commit a raw capture.** A frame carries your gateway's MAC and your account's sequence numbers; `device/info` carries your street address. `scripts/pseudonymise.js` rewrites and then audits, and a fixture guard fails the build. The point is not to get that far.
- **Do not break someone's rooms.** Accessory identity is what keeps a tile attached to its room, scenes and automations. Adding a capability must not change the identity of an existing accessory. If it must, say so explicitly in the PR so it is handled as a migration and not as a surprise.

## Reporting Bugs

Use the GitHub issue template. Include:
- Homebridge version
- Plugin version
- Node.js version
- Appliance model and the `family=` value from the startup log
- Steps to reproduce
- Expected vs actual behaviour
- Relevant logs, and the output of `node scripts/capture-fixture.js --redact`

**Never paste your NaviLink email, password, or anything from a sign-in response.** The tokens in that response are live credentials for your account and for AWS IoT.

## Feature Requests

Open an issue with:
- Clear description of the feature
- Use case / why it is needed
- Any implementation ideas

## Questions?

Check [existing issues](https://github.com/tbaur/homebridge-navilink/issues) first, and open a new one if your question is not already covered.

---

Thank you for contributing! 🎉
