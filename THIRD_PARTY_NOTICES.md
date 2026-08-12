# Third-party notices

The following direct npm dependencies are downloaded during installation and remain governed by their own license files and notices.

| Package | Role | Declared license |
| --- | --- | --- |
| `react` | Web user interface | MIT |
| `react-dom` | Browser rendering | MIT |
| `vite` | Development and production build tool | MIT |
| `@vitejs/plugin-react` | React build integration | MIT |
| `@tabler/icons-react` | Interface icon components | MIT |
| `playwright-core` | Optional connection to an operator-owned visible Chromium browser | Apache-2.0 |

Exact resolved versions are recorded in `package-lock.json`. Transitive dependencies are not reproduced in this short direct-dependency table; their metadata and installed license files remain authoritative. Review the lockfile and installed dependency notices when producing a distribution or software-bill-of-materials report.

The repository's `AGPL-3.0-only` license applies only to repository-owned source offered under that license. It does not replace, remove, or relicense third-party rights. Nothing in this notice grants trademark rights or overrides an upstream license.

## Vendored Tabler icon exports

The native mini-program tab bar includes monochrome PNG exports of these Tabler Icons v3.44.0 outline glyphs: `activity-heartbeat`, `target-arrow`, `list-details`, and `adjustments`. Normal and selected variants differ only in stroke color and weight. Tabler Icons is licensed under the MIT License:

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Project-owned interface artwork

The mini-program also includes two abstract raster assets created for this project from text-only prompts, without a person, photograph, platform logo, or third-party brand as input:

- `wechat-miniprogram/assets/branding/live-reminder.png` — SHA-256 `94619afd6cc0a11b99b7e4346788103492f5ab2b19431586246e3f6168ec7fea`
- `wechat-miniprogram/assets/avatars/channel.png` — SHA-256 `34531ee68acfb6e63318d1e9bc3a1ceba527fda4b71b3334c0873445d0971665`

They are repository-owned interface artwork offered under the repository's `AGPL-3.0-only` license. They are abstract placeholders, not identity, endorsement, or delivery evidence.

This file is a practical inventory, not legal advice. If dependency declarations change, update this table and verify the new licenses before release.
