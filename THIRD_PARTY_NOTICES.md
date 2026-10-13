# Third-party notices

vcli is an independent implementation. No Claude mirror source is included.
Exact dependency versions and integrity hashes are recorded in `bun.lock`.

| Component             | Version              | License                               |
| --------------------- | -------------------- | ------------------------------------- |
| OpenTUI Core / Solid  | 0.5.17               | MIT                                   |
| Solid                 | 1.9.12               | MIT                                   |
| TypeScript            | 5.9.3                | Apache-2.0                            |
| ELK.js                | 0.12.0               | EPL-2.0 (the EPL alternative is used) |
| resvg-js              | 2.6.2                | MPL-2.0                               |
| Ajv                   | 8.20.0               | MIT                                   |
| OpenAI SDK            | 7.32.0               | Apache-2.0                            |
| Anthropic SDK         | 0.133.0              | MIT                                   |
| Google GenAI SDK      | 2.28.0               | Apache-2.0                            |
| MCP TypeScript client | 2.3.1                | Apache-2.0                            |
| JetBrains Mono        | bundled regular font | SIL Open Font License 1.1             |

The build copies installed dependency licenses and notices, including transitive
packages, into `dist/licenses`, with a versioned index. Distribute that directory
and this file with the executable. The original JetBrains Mono license is
preserved in `packages/architecture/resources/OFL.txt` and copied beside the
executable. The font is unmodified and embedded solely for rendering diagrams.

ELK and resvg are unmodified. Their upstream source and corresponding releases
are available at [ELK.js](https://github.com/kieler/elkjs) and
[resvg-js](https://github.com/yisibl/resvg-js). These license notices do not change
the license terms of those components.

Compiled executables also contain the [Bun runtime](https://github.com/oven-sh/bun),
under its MIT license and bundled third-party licenses. Build artifacts preserve
Bun's upstream notice text in `dist/licenses/bun`.
