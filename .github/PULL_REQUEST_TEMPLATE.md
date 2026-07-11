<!--
Thanks for contributing to Folio! Please fill out this template so reviewers
have the context they need. Keep pull requests focused on one logical change.
-->

## Summary

<!-- What does this PR do, and why? A short, clear description. -->

## Linked issue

<!-- Link the issue this PR addresses, e.g. "Closes #123". PRs without an
associated issue are welcome for small fixes; add context here in that case. -->

Closes #

## Type of change

<!-- Check all that apply. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Performance improvement
- [ ] Documentation only
- [ ] Refactor / internal change (no user-facing behavior change)
- [ ] Build, CI, or tooling
- [ ] Plugin or AI/MCP feature (see the security and data-handling notes in CONTRIBUTING.md and SECURITY.md)

## Screenshots / recording

<!-- For any UI change, include before/after screenshots or a short screen
recording. Delete this section if it does not apply. -->

## Testing done

<!-- How did you verify your change? List commands run and manual steps taken. -->

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run test:e2e` (if the change affects user-facing flows)
- [ ] Manual testing (describe below)

Details:

## Accessibility checklist

<!-- Folio aims to be fully accessible. For UI changes, confirm the following.
Mark N/A if this PR has no user-facing UI. -->

- [ ] Keyboard: all new interactive elements are reachable and operable by keyboard, with a visible focus indicator and a logical tab order.
- [ ] Screen reader: elements have appropriate names, roles, and states (ARIA where needed); announcements make sense.
- [ ] Contrast: text and essential UI meet WCAG AA contrast in both light and dark themes.
- [ ] N/A: this PR has no user-facing UI changes.

## Final checklist

- [ ] My commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] All commits are signed off for the DCO (`git commit -s`).
- [ ] I have added or updated tests that prove my change works.
- [ ] I have updated documentation as needed (README, `docs/`, code comments).
- [ ] I have read the [Contributing guide](../CONTRIBUTING.md).
- [ ] CI is green (lint, typecheck, tests, build matrix, DCO).
