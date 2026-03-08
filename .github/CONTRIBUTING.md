# Contributing to Bot Discord Dashboard ALL-IN-ONE

First off — thank you for taking the time to contribute! 🎉

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Style Guidelines](#style-guidelines)

---

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## How Can I Contribute?

### 🐛 Reporting Bugs

1. Search existing [Issues](../../issues) to make sure the bug hasn't been reported already.
2. Open a new issue using the **Bug report** template.
3. Include:
   - A clear title and description
   - Steps to reproduce
   - Expected vs. actual behaviour
   - Environment (Node.js version, OS, bot version)

### 💡 Suggesting Enhancements

1. Open an issue using the **Feature request** template.
2. Describe the feature and why it would be useful.
3. If possible, include mockups or code snippets.

### 🔧 Submitting Code

1. Fork the repository.
2. Create a branch: `git checkout -b feature/your-feature-name`
3. Make your changes following the [Style Guidelines](#style-guidelines).
4. Commit your changes: `git commit -m "feat: add your feature"`
5. Push to your fork: `git push origin feature/your-feature-name`
6. Open a Pull Request against the `main` branch.

---

## Development Setup

```bash
# 1. Clone the repository
git clone https://github.com/aymenelouadi/Bot-Discord-Dashboard-ALL-IN-ONE---Next-Generation.git
cd Bot-Discord-Dashboard-ALL-IN-ONE---Next-Generation

# 2. Install dependencies
npm install

# 3. Copy the environment template
cp .env.example .env
# Edit .env and fill in your Discord credentials

# 4. Start the bot (also boots the dashboard)
npm start
```

---

## Pull Request Process

1. Ensure your code follows the [Style Guidelines](#style-guidelines).
2. Update relevant documentation (README, inline comments) if needed.
3. Make sure the bot still starts without errors (`npm start`).
4. Describe what your PR changes in the PR description.
5. Link any related issues using `Closes #123`.

PRs will be reviewed by a maintainer within **3–5 business days**.

---

## Style Guidelines

- **JavaScript:** Follow the existing code style (2-space indentation, `const`/`let`, async/await).
- **Comments:** Write clear, English-language comments for non-obvious logic.
- **Commit messages:** Use [Conventional Commits](https://www.conventionalcommits.org/) format:
  - `feat:` — new feature
  - `fix:` — bug fix
  - `docs:` — documentation only
  - `chore:` — tooling / dependencies
  - `refactor:` — code refactoring without behaviour change

---

> This project was programmed by the Code Nexus team.  
> Discord: https://discord.gg/UvEYbFd2rj
