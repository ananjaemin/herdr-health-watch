# Third-party notices

Health Watch's original custom runtime, installer, packaging scripts and documentation are licensed under the root [MIT LICENSE](LICENSE), copyright 2026 Health Watch contributors. No third-party executable is bundled by default. Health Watch is a community mod, not an official Herdr or Vitals release.

## Herdr Vitals 0.3.1 (external dependency)

- Upstream: https://github.com/mrolafsson/herdr-vitals
- Pinned release: https://github.com/mrolafsson/herdr-vitals/releases/tag/v0.3.1
- Pinned source: https://github.com/mrolafsson/herdr-vitals/tree/cfa895c75a23630cfc19727f820a4871d19df7b0
- Exact upstream license source: https://github.com/mrolafsson/herdr-vitals/blob/cfa895c75a23630cfc19727f820a4871d19df7b0/LICENSE
- Official archive checksums: https://github.com/mrolafsson/herdr-vitals/releases/download/v0.3.1/checksums.txt
- Release build configuration: https://github.com/mrolafsson/herdr-vitals/blob/cfa895c75a23630cfc19727f820a4871d19df7b0/.goreleaser.yml
- Dependency declarations for review: https://github.com/mrolafsson/herdr-vitals/blob/cfa895c75a23630cfc19727f820a4871d19df7b0/go.mod

The installer accepts only an explicitly supplied local archive matching [`dependencies.json`](dependencies.json). Official checksums cover the macOS/Linux ARM64/AMD64 archives. The additional macOS ARM64 binary digest is maintainer-supplied, not represented as an upstream-published standalone binary checksum. No other standalone binary checksum is claimed.

Upstream's normal installers and desktop mod can download dependencies and share Vitals sampler/history locations. Health Watch does **not** run those installers or ship that mod: it calls the pinned executable as a one-shot reader with its own isolated HOME, config and state. The config must explicitly disable background sampling, Vitals alerts, AI alerts and Herdr machine discovery; missing/invalid upstream config defaults can enable those features. The probe refuses a missing or altered config rather than relying on upstream defaults.

Primary source for isolation behavior: [config resolution/defaults](https://github.com/mrolafsson/herdr-vitals/blob/cfa895c75a23630cfc19727f820a4871d19df7b0/config.go#L58-L129), [app-mode reader](https://github.com/mrolafsson/herdr-vitals/blob/cfa895c75a23630cfc19727f820a4871d19df7b0/app.go). Even with background sampling disabled, the upstream app reader can write `app-alive` and `app-prev.json` in its state directory; isolation does not mean the reader is filesystem-write-free. Those files remain under Health Watch's isolated state location.

Upstream MIT notice, preserved in full:

```text
MIT License

Copyright (c) 2026 Hjortur Stefan Olafsson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Notification tools (separately installed, optional)

macOS `terminal-notifier` and Linux `notify-send` are user-provided external programs, not part of this package. Review the exact tool distribution's source, license and notices before installing it through your chosen package manager. This project does not provide, relicense, automatically install or update either program. The optional `--notifier` flag only links an existing executable selected by the user. No personal installation paths are embedded in the package.

## Host runtime

`herdr`, `gpui-kit` and `gpui-base` are supplied by the Herdr application. Their source, SDK and application binaries are not redistributed in this package. This notice does not grant rights to third-party host software or to dependencies within independently installed executables.
