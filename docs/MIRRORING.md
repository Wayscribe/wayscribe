# The GitHub mirror

GitLab is where this project lives. Every push, every pipeline, every merge
request, every issue. GitHub gets a read-only copy so people who look for
software there can find it.

The mirror is **gated on a green pipeline**: it runs only after format, lint,
typecheck, unit tests, integration tests, and the build have all passed on
`main`. A broken commit never reaches GitHub.

## Why this is a CI job and not GitLab's mirroring feature

GitLab has built-in repository mirroring under **Settings → Repository →
Mirroring repositories**, and it does not work for this.

Built-in mirroring fires **on push**. It has no idea whether a pipeline ran, let
alone whether it passed, so it would publish a red commit to GitHub within
seconds of you pushing it. The requirement here is "mirror what passed", and
only a job in the pipeline can know that.

The job also lets us push a specific set of refs, cut a GitHub Release from a
tag, and fail loudly when the token expires.

## One-time setup

Until `GITHUB_TOKEN` exists, both jobs are skipped by a rule. Nothing turns red
before you do this, and nothing is mirrored.

### 1. Create the GitHub repository

The mirror is `github.com/wayscribe/wayscribe`, in the `wayscribe` organization.
Create it empty. No README, no license, no `.gitignore`: the first mirror push
force-writes history, and an initial commit would just be overwritten.

### 2. Turn off everything that collects contributions

In **Settings → General → Features**, disable:

- **Issues**
- **Wiki**
- **Projects**
- **Discussions**
- **Sponsorships**

**Pull requests cannot be disabled.** GitHub offers no such setting.
`.github/PULL_REQUEST_TEMPLATE.md` explains the situation to anyone who opens
one, and `.github/ISSUE_TEMPLATE/config.yml` redirects issue links if Issues is
ever re-enabled by accident. Neither file is visible on GitLab.

Set the repository description to something that says it plainly:

```text
Read-only mirror. Development happens at https://gitlab.com/jojithedev/wayscribe
```

### 3. Create a fine-grained personal access token

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained
tokens**.

- **Repository access:** only the mirror repository. Not "all repositories".
- **Permissions:** `Contents: Read and write`. That covers pushing refs and
  creating releases. Nothing else is needed.
- **Expiry:** whatever you are willing to rotate. The failure mode is a red
  `mirror-to-github` job, which is loud and harmless: the mirror goes stale,
  nothing else breaks.

### 4. Add two CI/CD variables on GitLab

**Settings → CI/CD → Variables**:

| Variable | Value | Flags |
| --- | --- | --- |
| `GITHUB_TOKEN` | the token from step 3 | **Masked**, **Protected** |
| `GITHUB_REPOSITORY` | `wayscribe/wayscribe` | Protected |

**Protected matters.** It restricts the variable to protected branches and tags,
so a job on an unmerged feature branch cannot read a token that can write to your
public GitHub repository. `main` and `v*` tags are both protected under
**Settings → Repository → Protected branches / Protected tags** (tags since
2026-09-17). A tag that is not protected never sees the variable, so its mirror
and release jobs are skipped.

**Masked matters** too: it keeps the token out of job logs.

### 5. Push to main

The next green pipeline mirrors. Check the `mirror` stage.

## What runs, and when

| Job | Trigger | Does |
| --- | --- | --- |
| `mirror-to-github` | green pipeline on `main`, or any tag | force-pushes `main` and all tags |
| `github-release` | any tag, after the mirror | creates a GitHub Release from the matching `CHANGELOG.md` section |

Both are skipped entirely when `GITHUB_TOKEN` is unset.

`GIT_DEPTH: 0` on the mirror job is load-bearing. GitLab CI clones shallow by
default, and pushing a shallow clone produces a mirror with about twenty commits
of history, which looks perfectly normal until somebody runs `git log` and finds
the project apparently started last week.

## The force-push, and what it costs

`git push --force` is deliberate. GitHub is strictly downstream, and without it
the mirror breaks permanently the first time the two histories diverge.

The consequence is worth stating plainly: **anything committed on GitHub is
destroyed by the next mirror.** If someone opens a pull request there and it gets
merged, that work disappears the next time `main` goes green.

That is why the pull request template leads with it rather than burying it. If
you ever want to accept a GitHub contribution, port the commits to GitLab
*before* the next mirror runs.

## Rotating or revoking the token

Revoke it on GitHub and delete the CI variable. Both jobs stop existing on the
next pipeline; nothing else changes. Add a new one whenever you like; the next
green `main` pipeline catches GitHub up in one push.
