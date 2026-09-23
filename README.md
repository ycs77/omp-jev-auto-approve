# OMP Jev Auto Approve

An [Oh My Pi (OMP)](https://omp.sh/) extension that uses [TypeSafe's Jev](https://typesafe.ai/) model to review and automatically approve tool calls before they run.

## Installation

Install the extension for OMP:

```bash
omp install github:ycs77/omp-jev-auto-approve
```

Create an API key in the [TypeSafe Console](https://console.typesafe.ai/keys), then add it to your shell startup file, such as `~/.bashrc` or `~/.zshrc`, before starting OMP:

```bash
# TypeSafe AI
export TYPESAFE_API_KEY="your-api-key"
```

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
