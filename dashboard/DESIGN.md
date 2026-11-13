# Dashboard design

Use the shadcn Nova components with the neutral theme and Geist. Keep the background white, the text near black, and color limited to finding and gate states.

Use a narrow shadcn sidebar for overview and project navigation, with a 48px toolbar and compact content area. Keep project identity in the toolbar and saved-report metadata on one line. Show a small stats strip without large cards or duplicate headings. On mobile the sidebar becomes a drawer.

The overview shows portfolio stats, severity and category breakdowns, and the project table. Each project has Findings, Analytics and Checks tabs. Findings stay in a compact sortable data table, with pagination next to the filters. Keep repair guidance in native disclosures inside finding cells. Show failed checks before the tabs.

Analytics use full saved-report totals, including findings hidden by report mode. Label unavailable legacy totals and keep snapshot provenance accessible. Use ordinary links for project navigation and report access. Respect keyboard focus and reduced motion.
