# Third-party code shipped in the image

npm dependencies are installed from `package-lock.json` and keep their own license files in `node_modules`. This page lists code that is **vendored** into the repository and served to browsers.

## Tabulator 6.7.1

| | |
| --- | --- |
| What | Interactive table/grid library used by the CyberDrive tables grid ([docs/tables.md](tables.md)) |
| Version | 6.7.1 (pinned; the file names carry the version) |
| License | MIT, Copyright (c) 2015-2026 Oli Folkerd. Full text: `src/web/static/vendor/tabulator/LICENSE` |
| Source | npm `tabulator-tables@6.7.1` (`dist/js/tabulator.min.js`, `dist/css/tabulator.min.css`, `LICENSE`), https://github.com/olifolkerd/tabulator |
| npm integrity | `sha512-6CMy17XdemQaIdg1BOqD5K6nzF2xoD47eRNiBYJBK+QrLWji7sgukyPjKXYrjRdWLwbGENdUsiAYJrNS3XeUfw==` |
| Served at | `/assets/vendor/tabulator-6.7.1.min.js`, `/assets/vendor/tabulator-6.7.1.min.css` (same origin, so the CSP stays `script-src 'self'`) |

SHA-256 of the vendored files:

```
4e218e8d309e9b704089e7808f5484f5257ea645ba4e4808c0ae13969500d55c  tabulator-6.7.1.min.js
ff598d8e961398e09a8e52ab21740e5ed952c84feebbdacec8f8a362dd3f73db  tabulator-6.7.1.min.css
191a2ee554684e1064c897b432f0e1bc6dfa714ca045d3f6ea2cf692cbd398b7  LICENSE
```

The source map comment at the end of the minified file is not served (`.map` paths answer 404).

To upgrade, download the new release from npm (`npm pack tabulator-tables@X.Y.Z`), check its license, replace the three files, rename them to the new version, update `src/web/static.ts`, the hashes above and the `CHANGELOG`, and run the tests (`test/tables-web.test.ts` checks the asset routes and the CSP).
