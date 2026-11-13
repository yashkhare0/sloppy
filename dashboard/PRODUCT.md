# Sloppy dashboard

## Platform

Web, served locally by the Sloppy CLI.

## Purpose

Show saved Sloppy reports for all assessed projects on this machine. Let the user find a project, inspect its gate outcome, checks and findings, and read its report.

## Constraints

Use shadcn and keep the whole interface minimal. Read the existing reports; refreshing does not run checks. Preserve gate status, full severity totals, baseline counts and report-mode filtering. Saved reports do not establish the current working tree's quality.

Use a sidebar and compact dashboard layout. Show portfolio and project stats with severity and finding-category breakdowns from the full saved assessments. Check completion counts applicable enabled checks, rather than repository test coverage.

The audience is inferred from the existing CLI: developers reviewing local project assessments.
