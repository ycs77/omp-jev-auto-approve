# OMP Jev Auto Approve

An [Oh My Pi (OMP)](https://omp.sh/) extension that uses [TypeSafe's Jev](https://typesafe.ai/) to review Bash commands, eval code, and local file paths before tool calls run. It automatically approves high-confidence safe calls and routes uncertain calls to you.

> [!WARNING]
> Jev assessments may be incorrect, incomplete, or unavailable. Automatic approval does not guarantee safety. `read`, `write`, and `edit` are reviewed by path only: file contents and edits are not inspected. Protocol paths (such as `xd://` and `skill://`) bypass path review, and Bash or eval code can access files indirectly. Review the risks before using this extension.

## Installation

Install the extension for OMP:

```bash
omp install omp-jev-auto-approve
```

Create an API key in the [TypeSafe Console](https://console.typesafe.ai/keys), then configure it in OMP with `/login typesafe`.

## Approval policy

- `bash`: only `allow` entries in OMP's `bash.patterns` skip Jev. The full command must match the rule exactly; `*` is the only wildcard and matches zero or more characters. Other rules and unmatched commands go to Jev; OMP still makes the final execution decision.
- `read` / `write` / `edit`: review local paths only, not file contents or patches. Protocol targets such as `xd://` and `skill://` are skipped.
- `eval`: review the language, code, and working directory. Code is sent to TypeSafe; do not include secrets.
- `safe` assessments with confidence at least `0.9` are auto-approved; `dangerous` assessments are denied. `uncertain` or lower-confidence results require manual approval.

## Sponsor

If you think this package has helped you, please consider [Becoming a sponsor](https://www.patreon.com/ycs77) to support my work~ and your avatar will be visible on my major projects.

<p align="center">
  <a href="https://www.patreon.com/ycs77">
    <img src="https://cdn.jsdelivr.net/gh/ycs77/static/sponsors.svg" alt="Sponsors" />
  </a>
</p>

<a href="https://www.patreon.com/ycs77">
  <img src="https://c5.patreon.com/external/logo/become_a_patron_button.png" alt="Become a Patron" />
</a>

## License

[MIT LICENSE](LICENSE)
