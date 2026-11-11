# Graphoscope

## AI agents use this app through links

Every view setting can be set by a URL parameter, pages report `html[data-status="done"]`
when ready to screenshot, and `static/llms.txt` is the reference agents read. When you
change the UI (add, rename or remove a setting, layout, colour mode or `/gfa` example,
or add a loading step before the picture is final), update the URL parameters,
`static/llms.txt`, the README and the ready signal in the same change. The full list of
places is in the README under "Keeping the AI-facing docs in sync".

Run `npx vitest run src/lib/urlState.test.ts` after such a change: it fails when
`llms.txt` misses a parameter, layout, colour mode or example id.
