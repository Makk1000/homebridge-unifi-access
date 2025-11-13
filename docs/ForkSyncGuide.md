# Maintaining a Custom Fork Release

This repository is a fork of [`hjdhjd/homebridge-unifi-access`](https://github.com/hjdhjd/homebridge-unifi-access). The steps below capture the complete workflow for keeping this fork aligned with upstream releases while preserving prior fork-specific versions (for example, keeping `v1.9.3` available while building a new `v1.10.1`).

## 1. Prepare remotes and tags

1. Clone your fork and add upstream once:
   ```bash
   git clone https://github.com/makk1000/homebridge-unifi-access.git
   cd homebridge-unifi-access
   git remote add upstream https://github.com/hjdhjd/homebridge-unifi-access.git
   git fetch origin --tags
   git fetch upstream --tags
   ```
2. Verify the previous release tag exists and create it if necessary:
   ```bash
   git tag -l v1.9.3 || git tag v1.9.3
   git push origin v1.9.3
   ```

## 2. Preserve a rollback branch (optional but recommended)

Create a branch that points at the old tag so you can inspect or rebuild it without touching the tag itself:
```bash
git branch v1.9.3-backup v1.9.3
git push origin v1.9.3-backup
```

## 3. Start a release branch for the new upstream version

```bash
git checkout main
git pull --ff-only origin main
git checkout -b release/v1.10.1
```

Rebase (or merge) on top of upstream’s latest main branch:
```bash
git fetch upstream
git rebase upstream/main
```

If Git reports a conflict (for example in `docs/Changelog.md` or `src/access-controller.ts`), open the file, reconcile the `<<<<<<<` / `=======` / `>>>>>>>` sections, then continue:
```bash
git status    # shows which files need attention
git add <file>
git rebase --continue
```
Repeat until `git status` is clean and the rebase finishes.

## 4. Reapply fork-specific patches and run checks

If the rebase dropped any custom commits, reintroduce the changes now and commit them normally. Then reinstall dependencies and run the quality gates defined in `package.json`:
```bash
npm install
npm run lint
npm run build
```

## 5. Update metadata and changelog

1. Edit `package.json`, `package-lock.json`, and `docs/Changelog.md`:
   * bump the version (e.g., `1.10.1`),
   * document that this release equals upstream `v1.10.0` plus your fork changes.
2. Stage and commit:
   ```bash
   git add package.json package-lock.json docs/Changelog.md
   git commit -m "chore: release 1.10.1"
   ```

## 6. Tag, push, and update main

```bash
git tag -a v1.10.1 -m "My fork: upstream 1.10.0 plus custom tweaks"
git push origin release/v1.10.1
git push origin v1.10.1
git checkout main
git merge --ff-only release/v1.10.1
git push origin main
```

## 7. Install or publish

Install the freshly built package using the existing workflow (the `prepublishOnly` hook will rerun lint/build):
```bash
sudo npm install -g .
```

To revert later, simply check out the preserved tag or branch:
```bash
git checkout v1.9.3       # or v1.9.3-backup
npm install
npm run build
sudo npm install -g .
```

Following this checklist keeps both releases available and documents the conflict-resolution steps that may appear while rebasing (`git status`, `git add`, `git rebase --continue`).
package-lock.json
