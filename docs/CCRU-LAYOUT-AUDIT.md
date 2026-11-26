# CCRU layout audit · November 25, 2026

**Decision for the lab:** use the independent layout for a distributed preview or public release. Keep attribution for the design inspiration. Do not publish the original vend in a branch's history merely because a later commit removes it.

## What the candidate used

The [upstream repository](https://github.com/lumpenspace/ccru/tree/7c38ad910410c3f5744b961eb97adf58ff00d41f) is public. Its [pinned package manifest](https://github.com/lumpenspace/ccru/blob/7c38ad910410c3f5744b961eb97adf58ff00d41f/package.json) marks the npm package private and has no license field. GitHub's repository API returned no license, the complete pinned tree had no named license/notice/copying file, and the root README contained no express reuse grant that I found. All ten local component/declaration files recorded in the original candidate's provenance matched their pinned upstream SHA-256 digests. This was copying code, not just borrowing an idea.

| Original candidate, `21ab204` | Actual production use |
| --- | --- |
| CyberPanel and its CyberPanelHeader helper | Terminal theme's two plot overlays: Legend and Notes. |
| CyberContainer | Terminal theme's collapsible control sections, e.g. Data and Export. |
| CyberStackGroup | Vertical group of those sections. |
| CyberGridGroup | Imported by the plot grid but never rendered there. The actual comparison grid uses the app's CSS. |
| Main control-panel divider; assistant docking | App-owned, not CCRU. The Bauhaus accordion is a separate dependency. |

**Dependencies:** the original CCRU website declared Next, React, React DOM, Vercel analytics/blob, Prism rendering, a live editor and resizable panels. By `21ab204` the full CCRU dependency was already gone. Its small copied adapter had no runtime dependencies or install hooks and only a React peer. Thus replacing it removes the copied code and one workspace package; it does **not** remove the app's own React/Next or imply another large bundle saving. The separately sourced MIT-licensed Plotly adapter is unaffected.

## Permission versus credit

A public repository can be readable without granting permission to redistribute its contents in a different project. Credit identifies the author; it does not supply the missing grant. Neither a private npm flag nor labeling our copy “UNLICENSED” resolves that. See [GitHub's licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository). This is a source audit, not a legal opinion. Written permission from the rightsholder covering public source and hosted bundles would be an alternative.

## Replacement and review

The alternative starts at `7382376`, before the copied adapter entered local history. It carries across the teammate-release changes **except** the vend and its vendor-specific tests. It implements a disclosure using React state, a native button, expanded-state semantics, and app styles; a plain flex container handles stacking. Unused grid imports, compatibility mocks, vend-specific lint exemptions, the workspace dependency and its lock entries are gone. No replacement UI dependency was added. Credit: [lumpenspace/ccru](https://github.com/lumpenspace/ccru) inspired the earlier Terminal layout.

Use the clean-parent candidate for integration; don't merge or push `21ab204` into a release branch that must exclude those bytes. The original branch has not been reset or rewritten. This audit concerns CCRU, not the licensing of every dependency in the project.
