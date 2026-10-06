# Web Arena redesign: race lanes

Status: approved in conversation, not committed.

## Goal

Make `/web-arena` look and feel better than Enrich Arena while staying on brand. Keep treg's design
system (tokens, fonts, dotted canvas, pixel fighters, treg mark). Only Web Arena changes; Enrich
Arena files are not edited. The backend API and schema do not change.

## Feedback addressed

| # | Problem | Decision |
|---|---|---|
| a | The provider lineup takes too much space | A compact roster strip of small pixel heads inside the command card |
| b | The center nav holds only Arena and Treg | Remove it; the page is the arena; the brand still links home |
| c | The leaderboard opens on hit rate | Price is the first and default view, also after loading a saved run |
| d | General search providers on every search type | Dropped for now (agreed with the CEO) |
| e | Nothing happens after Run | Smooth scroll to the fight stage on Run; never fight a user who scrolls away |
| f | The loading state is unclear | One live lane per provider with state, timer, shimmer and progress header |
| g | The page copies Enrich Arena | New layout and motion on the same design system |
| h | The account bar is weak | Balance becomes a top-up button; a "Setup treg in [agents] +N" pill opens setup |

## Page, top to bottom

1. **Top bar.** `treg / Web Arena` on the left. No center nav. Right side when signed in: team
   switcher (more than one team), balance button (opens top-up), "Setup treg in" pill, community
   links, Sign out. Signed out: community links and Sign up. On narrow screens the account items
   fold into one menu.
2. **Command card.** One flat row of task chips (Web, News, Papers, YouTube, Maps, Fetch,
   Sitemap, Brand · Soon) with a sliding active indicator. A large input with the Run button
   inside it; the button carries the quoted price. The Sitemap phrase field stays for Sitemap.
   Below: the roster strip of provider heads (click to include or exclude, hover for name and
   price), the Battle or Waterfall switch, and the quality switch with its help tooltip.
   Task hints (TinyFish count, ten-result notes, Maps area) stay as one short line.
3. **Fight stage.** Shown after Run or when a saved run opens. Header: the query, the mode, "N of
   M done · elapsed", a thin progress bar and Stop while running. One lane per attempt in quote
   order; lanes never reorder.
4. **Leaderboard.** Same content and charts. Views start with Price.
5. **History sidebar.** Unchanged.

## Lane states

| Attempt state | Lane |
|---|---|
| queued | Dim fighter; "Waiting for a slot" (Battle) or "Next if needed" (Waterfall) |
| running | Fighting pose, moving shimmer, live timer counted in the browser |
| hit, quality pending | Result shown; "Checking quality…" shimmer text |
| hit | Opens into the result: links or fetch preview, metrics, finish place, thumbs, raw response |
| miss, error, timeout | One line, fallen fighter, plain reason, cost |
| not_attempted | Grey; Waterfall: "Not needed: an earlier provider answered." |
| cancelled, interrupted | "Run stopped" or "Interrupted", cost if any |

The finish place ("Finished 1st") comes from the order in which the browser first saw a lane
leave `running` during a live run; saved runs omit it. The final time is the saved `duration_ms`.
On completion, badges (Fastest, Cheapest, Most Relevant, Token Efficient) pop onto lanes and the
winners hold a victory pose. The card and table switch remains.

## Revision 2 (after review)

- **Roster as one line.** `Fighters · [faces] · N of M · Edit`; Edit opens the chips. Running closes it.
- **No collapsed results.** Every hit lane always shows its top four links (two on phones), with
  View all and View provider response. A collapsed hit read as "no result". No accordion on lanes.
- **One intent match.** The chip row duplicate is gone; the help icon sits beside the status text.
- **Thin strip instead of a header card.** While live: orb, `Battle · 6 of 10 done · 4.2s`,
  progress, Stop, pinned. After: totals, Waterfall stop reason, view switch. The faces board is gone.
- **Query label only when needed.** `Results for "…"` shows only when the search box changed.
- **No left accent bar** on lanes.
- **Provider orbs** replace lane robots: a dotted, pixel-dot sphere with the provider logo as its face.
  Battle waiting = calm ring, Waterfall waiting = sleeping grey ring (a relay), running = scan
  (search), links (sitemap), weave (fetch); quality check = turning bands; hit = teal ring;
  failure = grey dots falling. Badge winners keep the pixel fighter's victory pose. Our own code,
  not copied from the reference file.
- **Places by provider time,** so 1st always matches Fastest; saved runs show the same places.
- Skipped providers fold into one line; zero prices read Free.

## Revision 3 (after review)

1. A Waterfall stops at the first provider that returns a result (cheapest first). Jev still scores
   it for the card and the live totals; it never decides when to stop. Backend change.
2. Waterfall relay: only providers that tried, or the one about to, get a card; the rest wait in
   one "Next up" line, gone once a result arrives.
3. The "not needed" line says why in plain words (who returned results, the $10 limit, an unknown
   fee, a stopped run); the backend stop reason no longer shows in the strip.
4. A request that cannot reach the server says so plainly instead of "Failed to fetch".
5. Orbs removed. Cards show the plain logo: grey while waiting, a soft teal pulse while working.
6. Links are marked by quiet dots; the rank stays for screen readers.
7. Thumbs sit at the bottom right of each card; one-line failed cards keep them on their line.
8. Speed place tags removed; the Time column and the Fastest badge already say it.
9. Sitemap states its count once ("N valid site URLs" or "N site URLs · M valid").
10. Task tab arrows return, shown only on the side that can scroll.
11. Sitemap topic hides behind "+ Filter links by topic".
12. Battle uses a two-column card grid (one column under about 720px); Waterfall keeps lanes.
13. Roster line reads "[logos] +N of M" with no separate count.
Also removed: the per-task hint lines, the mode note, and the roster instruction text.

## Revision 4 (after review)

- **Provider bots** on result cards: a canvas robot head in treg ink with smooth light; the logo is
  a vector image laid over the head so it stays sharp. Running hops (every third hop spins), quality
  checks hop gently, waiting stands, never-called dozes, a result hops once with a teal glow, badge
  winners hop now and then, failures slump with a grey logo. Our own code, inspired by a reference.
- **Roster:** logo chips (no bots), 38px, tighter spacing, teal border and check when selected,
  color logos when off, no hover price. The closed line shows logos and "+N of M"; open, it shows a
  live "N of M selected" and an "All providers" switch beside Done while some are off. No label.
- **Strip:** a small working orb and a thin progress bar with a soft sweep; the total charged so
  far and when finished; a Fetch fact check is reported only here.
- **Cards:** running cards have a faint teal border and one soft sweep along the bottom edge; Battle
  rows share a height with actions pinned to the bottom; no "Thumbs down" text; Fetch cards drop
  "Page text returned".
- **Command card:** no tagline, no price line (the Run button tooltip notes the charge may vary), a
  smaller search box, and Fetch/Sitemap show a fixed https:// prefix with paste normalisation and
  delayed validation; a bare address is read as https on the server too.
- **History** folds into a rail with tooltips; phones show only New query.
- Active tabs keep their pill on hover; Run scrolls only after an open roster has closed.

## Motion

Use transitions.dev patterns: sliding tabs for task chips and mode switch, staggered lane entry,
accordion lane expansion, shimmer text for running and checking states, number pop-in for final
time and cost, badge pop. Motion only signals a state change. `prefers-reduced-motion` turns it off
and auto-scroll becomes an instant jump.

## Accessibility

Stage progress is an `aria-live` polite region. Lanes are articles with the provider name as the
heading. All existing labels, tooltips and keyboard behavior for tabs and the roster are kept.

## Files

- `src/treg/web/web-arena.html`
- `src/treg/web/web-arena/arena.js`
- `src/treg/web/web-arena/arena.css`
- `docs/context/interface/web-arena.md` (layout description)

Enrich Arena's stylesheet is still loaded for shared tokens, sprites and the setup dialog;
overrides live in the Web Arena stylesheet.

## Verification

Existing test suite and `lint-imports` stay green. Drive the worktree server in a browser:
signed out and in, every task, a real Battle and Waterfall, Stop, a saved run, top-up, setup,
phone width and reduced motion.
