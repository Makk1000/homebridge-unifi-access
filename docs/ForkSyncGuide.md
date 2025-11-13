# Maintaining a Custom Fork Release

This repository is a fork of [`hjdhjd/homebridge-unifi-access`](https://github.com/hjdhjd/homebridge-unifi-access). The steps below capture the complete workflow for keeping this fork aligned with upstream releases while preserving prior fork-specific versions (for example, keeping `v1.9.3` available while building a new `v1.10.1`).

> **Scenario recap**
>
> * `origin` = [`makk1000/homebridge-unifi-access`](https://github.com/makk1000/homebridge-unifi-access) (fork).
> * `upstream` = [`hjdhjd/homebridge-unifi-access`](https://github.com/hjdhjd/homebridge-unifi-access) (official source).
> * Published fork tag `v1.9.3` must remain untouched so it can be reinstalled at any time.
> * We want to consume upstream `v1.10.0`, layer fork-only patches on top, and tag / publish the result as `v1.10.1`.
>
> These notes assume `main` already points to the current fork release and that a `v1.9.3` backup has been created, but the commands below show how to recreate that safety net whenever necessary.

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

   _This protects the old release even if `main` moves forward._

## 2. Preserve a rollback branch (optional but recommended)

Create a branch that points at the old tag so you can inspect or rebuild it without touching the tag itself:
```bash
git branch v1.9.3-backup v1.9.3
git push origin v1.9.3-backup
```

You can create additional archive branches if more hotfix lines are needed later.

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
Repeat until `git status` is clean and the rebase finishes. Seeing the same filename appear in multiple successive commits is normal—each upstream commit that touched that file must be reconciled once. As long as `git status` only lists the current commit’s conflicts, you are on the right track. If you realize a conflicted commit is no longer needed (for example, upstream already contains your change), `git rebase --skip` will drop it safely, and `git rebase --abort` returns you to the pre-rebase state if you want to start over.

> **Tip:** If you are facing dozens of similar conflicts, enable Git’s conflict memoization so resolved hunks are remembered for the rest of the rebase:
> ```bash
> git config rerere.enabled true
> git config rerere.autoupdate true
> ```
> After turning this on, resolve the conflict once, stage the file, and Git will auto-apply the same choice when the pattern reappears later in the rebase.

## 4. Reapply fork-specific patches and run checks

If the rebase dropped any custom commits, reintroduce the changes now and commit them normally. `git log upstream/main..HEAD` is handy for spotting which patches are unique to the fork. Then reinstall dependencies and run the quality gates defined in `package.json`:
```bash
sudo npm install
sudo npm run lint
sudo npm run build
```

## 5. Update metadata and changelog

1. Edit `package.json`, `package-lock.json`, and `docs/Changelog.md`:
   * bump the version (e.g., `1.10.1`),
   * document that this release equals upstream `v1.10.0` plus your fork changes,
   * double-check that any custom release notes (for example, “preserves ability to reinstall `v1.9.3`”) are included.
2. Stage and commit:
   ```bash
   git add package.json package-lock.json docs/Changelog.md
   git commit -m "chore: release 1.10.1"
   ```

## 6. Tag, push, and update main

```bash
git tag -a v1.10.1 -m "My fork: upstream 1.10.0 plus custom tweaks"
git push origin release/v1.10.1   # push the branch before deleting it locally
git push origin v1.10.1
git checkout main
git merge --ff-only release/v1.10.1
git push origin main
```

### When the push fails

* **`fatal: tag 'v1.10.1' already exists`** – the tag already lives locally. If it also lives on the
  remote, you can skip the `git tag` and `git push origin v1.10.1` commands. If you intentionally
  need to recreate it, delete the local and remote copies first:
  ```bash
  git tag -d v1.10.1
  git push origin :refs/tags/v1.10.1
  # retag, then push again
  git tag -a v1.10.1 -m "My fork: upstream 1.10.0 plus custom tweaks"
  git push origin v1.10.1
  ```
* **`error: src refspec release/v1.10.1 does not match any`** – the branch does not exist locally,
  usually because `git checkout -b release/v1.10.1` was never run or the branch was deleted after
  rebasing. Recreate it from the commit you plan to ship (often `main`), then push:
  ```bash
  git checkout -b release/v1.10.1 <commit>
  git push origin release/v1.10.1
  ```
* **`merge: release/v1.10.1 - not something we can merge`** – you tried to fast-forward `main`
  after the release branch was deleted. Recreate / fetch the branch, then merge.
* **`Updates were rejected because the remote contains work that you do not have locally`** – run
  `git pull --ff-only origin main` to obtain the upstream changes before pushing.

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
